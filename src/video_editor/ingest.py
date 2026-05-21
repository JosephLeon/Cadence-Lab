"""Ingest stage: probe the source video, normalize, and extract the mic audio track.

OBS recordings frequently contain multiple audio streams (mic + desktop audio on
separate tracks). For speech analysis we want the mic track alone — desktop audio
would mask the pauses we're trying to detect. We also normalize to 16 kHz mono WAV,
which is what Silero VAD and Whisper both expect as input.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path

from .models import AudioTrack, IngestResult, SourceProbe


class IngestError(RuntimeError):
    pass


def _require_tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise IngestError(f"{name} not found on PATH — install ffmpeg first")
    return path


def probe(source: Path) -> SourceProbe:
    """Run ffprobe and return a structured view of the source file."""
    if not source.exists():
        raise IngestError(f"source file does not exist: {source}")

    ffprobe = _require_tool("ffprobe")
    raw = subprocess.run(
        [
            ffprobe,
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            str(source),
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    data = json.loads(raw)

    fmt = data.get("format", {})
    streams = data.get("streams", [])

    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]

    frame_rate: float | None = None
    is_vfr = False
    video_codec: str | None = None
    width: int | None = None
    height: int | None = None

    if video_stream is not None:
        video_codec = video_stream.get("codec_name")
        width = video_stream.get("width")
        height = video_stream.get("height")
        avg = video_stream.get("avg_frame_rate", "0/0")
        r = video_stream.get("r_frame_rate", "0/0")
        try:
            avg_fr = float(Fraction(avg)) if avg and avg != "0/0" else None
            r_fr = float(Fraction(r)) if r and r != "0/0" else None
        except (ZeroDivisionError, ValueError):
            avg_fr = r_fr = None
        frame_rate = avg_fr or r_fr
        # If avg and r differ noticeably, the source is variable-frame-rate.
        if avg_fr and r_fr and abs(avg_fr - r_fr) > 0.5:
            is_vfr = True

    tracks: list[AudioTrack] = []
    for i, s in enumerate(audio_streams):
        tags = s.get("tags") or {}
        tracks.append(
            AudioTrack(
                index=i,
                codec=s.get("codec_name", "?"),
                channels=s.get("channels", 0),
                sample_rate=int(s.get("sample_rate", 0) or 0),
                language=tags.get("language"),
                title=tags.get("title") or tags.get("handler_name"),
                duration_seconds=(
                    float(s["duration"]) if s.get("duration") else None
                ),
            )
        )

    return SourceProbe(
        path=source.resolve(),
        duration_seconds=float(fmt.get("duration", 0.0)),
        container=fmt.get("format_name", "?"),
        video_codec=video_codec,
        width=width,
        height=height,
        frame_rate=frame_rate,
        is_variable_frame_rate=is_vfr,
        audio_tracks=tracks,
    )


def extract_mic_audio(
    source: Path,
    mic_track_index: int,
    output_path: Path,
    sample_rate: int = 16000,
) -> Path:
    """Extract a single audio track and resample to mono 16-bit PCM at `sample_rate`.

    The result is the canonical input for downstream VAD and Whisper.
    """
    ffmpeg = _require_tool("ffmpeg")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-i", str(source),
            "-map", f"0:a:{mic_track_index}",
            "-ac", "1",
            "-ar", str(sample_rate),
            "-c:a", "pcm_s16le",
            "-vn",
            str(output_path),
        ],
        check=True,
        capture_output=True,
    )
    return output_path


def ingest(
    source: Path,
    work_dir: Path,
    mic_track_index: int = 0,
) -> IngestResult:
    """Probe the source and extract the mic-only normalized WAV."""
    src = probe(source)
    if mic_track_index >= len(src.audio_tracks):
        raise IngestError(
            f"requested mic track {mic_track_index} but source has only "
            f"{len(src.audio_tracks)} audio track(s)"
        )

    normalized = extract_mic_audio(
        source=source,
        mic_track_index=mic_track_index,
        output_path=work_dir / f"{source.stem}.mic.16k.wav",
    )

    return IngestResult(
        source=src,
        mic_track_index=mic_track_index,
        normalized_audio_path=normalized.resolve(),
    )
