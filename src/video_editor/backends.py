"""Transcription backends.

Two backends are supported:

- **groq** (default): uploads the mic audio to Groq's hosted whisper-large-v3
  endpoint. Same model as the local backend, but runs at ~30× realtime on Groq's
  custom inference hardware. Requires `GROQ_API_KEY` in the environment.
- **local**: faster-whisper running ctranslate2 on the Apple Silicon CPU.
  Offline, ~5-10× *slower* than realtime on M-series CPUs.

Both backends return the same `(segments, language, language_prob, duration)`
tuple, so the rest of the pipeline doesn't care which one ran.

For Groq, the mic audio is compressed to Opus 64 kbps mono before upload. That
codec/bitrate is well within Whisper's training distribution for speech (no
measurable WER impact at 64 kbps), and it shrinks a 30-min mic recording from
~35 MB FLAC to ~14 MB. Anything still over Groq's 25 MB limit is split at
silence boundaries and the chunk transcripts stitched back together with
timestamp offsets — so an arbitrarily long video Just Works.
"""

from __future__ import annotations

import math
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Literal

import torch
from dotenv import load_dotenv
from faster_whisper import WhisperModel

from .models import TranscriptSegment, Word

Backend = Literal["groq", "local"]
WhisperModelSize = Literal["tiny", "base", "small", "medium", "large-v3"]
ComputeType = Literal["int8", "int8_float16", "float16", "float32"]

GROQ_MODEL = "whisper-large-v3"
GROQ_MAX_BYTES = 25 * 1024 * 1024  # current free-tier upload limit

# Opus at 64 kbps mono is the sweet spot for Whisper: codec is in-distribution,
# bitrate is high enough that there's no measurable WER impact on speech, and
# the file is small enough to upload comfortably. Lower bitrates (32 kbps) work
# fine too but leave less safety margin against noisy room recordings.
UPLOAD_BITRATE_KBPS = 64
# Target ~90% of the hard limit when we have to chunk, so we never round into
# overflow after Opus VBR variation.
CHUNK_TARGET_BYTES = int(GROQ_MAX_BYTES * 0.90)

load_dotenv()


# ─── ffmpeg helpers ───────────────────────────────────────────────────────────


def _ffmpeg() -> str:
    p = shutil.which("ffmpeg")
    if not p:
        raise RuntimeError("ffmpeg not found on PATH")
    return p


def _audio_duration(audio_path: Path) -> float:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("ffprobe not found on PATH")
    out = subprocess.run(
        [
            ffprobe, "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(audio_path),
        ],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return float(out)


def _compress_to_opus(audio_path: Path, work_dir: Path) -> Path:
    """Transcode the mic WAV to Opus 64 kbps mono for compact upload."""
    work_dir.mkdir(parents=True, exist_ok=True)
    out = work_dir / f"{audio_path.stem}.opus"
    subprocess.run(
        [
            _ffmpeg(), "-y", "-i", str(audio_path),
            "-c:a", "libopus",
            "-b:a", f"{UPLOAD_BITRATE_KBPS}k",
            "-ac", "1",
            "-application", "voip",  # tuned for speech intelligibility
            str(out),
        ],
        check=True, capture_output=True,
    )
    return out


_SILENCE_START_RE = re.compile(r"silence_start:\s*([0-9.]+)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*([0-9.]+)")


def _detect_silences(
    audio_path: Path,
    noise_db: float = -30.0,
    min_silence_s: float = 0.4,
) -> list[tuple[float, float]]:
    """Return [(silence_start, silence_end), ...] using ffmpeg silencedetect.

    We use this purely to find *safe split points* — not to drive cuts. The
    only thing the chunker cares about is "where can I cut without slicing
    through a word."
    """
    proc = subprocess.run(
        [
            _ffmpeg(), "-i", str(audio_path),
            "-af", f"silencedetect=noise={noise_db}dB:d={min_silence_s}",
            "-f", "null", "-",
        ],
        capture_output=True, text=True,
    )
    log = proc.stderr  # silencedetect writes to stderr
    starts = [float(m.group(1)) for m in _SILENCE_START_RE.finditer(log)]
    ends = [float(m.group(1)) for m in _SILENCE_END_RE.finditer(log)]
    # Pair them up; if the audio ends in silence, ffmpeg may not emit a final
    # silence_end. Truncate to the shorter list to stay safe.
    return list(zip(starts, ends[: len(starts)]))


def _pick_split_points(
    duration: float,
    silences: list[tuple[float, float]],
    num_chunks: int,
) -> list[float]:
    """Choose `num_chunks - 1` split times, snapping each toward the nearest silence.

    Targets equal-duration chunks first, then for each target finds the silence
    midpoint closest to it. Falls back to the raw target if no silence is within
    a generous window — better to cut mid-word once than to OOM the upload.
    """
    if num_chunks <= 1:
        return []
    targets = [duration * (i + 1) / num_chunks for i in range(num_chunks - 1)]
    if not silences:
        return targets
    midpoints = [(s + e) / 2 for s, e in silences]

    splits: list[float] = []
    for t in targets:
        nearest = min(midpoints, key=lambda m: abs(m - t))
        # Only snap if the silence is within ±20% of chunk length; otherwise
        # use the raw target so we don't create wildly unbalanced chunks.
        window = (duration / num_chunks) * 0.2
        splits.append(nearest if abs(nearest - t) <= window else t)
    # Sort + de-dup in case two targets snapped to the same silence.
    splits = sorted(set(round(s, 3) for s in splits))
    return splits


def _slice_audio(
    audio_path: Path,
    splits: list[float],
    work_dir: Path,
) -> list[tuple[Path, float]]:
    """Slice `audio_path` into N pieces at `splits`. Returns [(path, start_offset)]."""
    duration = _audio_duration(audio_path)
    boundaries = [0.0, *splits, duration]
    chunks: list[tuple[Path, float]] = []
    for i in range(len(boundaries) - 1):
        start = boundaries[i]
        end = boundaries[i + 1]
        out = work_dir / f"{audio_path.stem}.chunk{i:02d}.opus"
        subprocess.run(
            [
                _ffmpeg(), "-y",
                "-ss", f"{start:.3f}",
                "-to", f"{end:.3f}",
                "-i", str(audio_path),
                "-c:a", "copy",  # already-compressed Opus, just cut containers
                str(out),
            ],
            check=True, capture_output=True,
        )
        chunks.append((out, start))
    return chunks


# ─── Groq response parsing ────────────────────────────────────────────────────


def _attr(obj, key, default=None):
    """Loose attribute/key access — the Groq SDK returns Pydantic-ish objects."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _parse_groq_response(resp, time_offset: float = 0.0) -> list[TranscriptSegment]:
    """Convert a verbose_json Groq response into our TranscriptSegment list."""
    raw_segments = _attr(resp, "segments", []) or []
    raw_words = _attr(resp, "words", []) or []

    out: list[TranscriptSegment] = []
    for i, s in enumerate(raw_segments):
        s_start = float(_attr(s, "start", 0.0)) + time_offset
        s_end = float(_attr(s, "end", 0.0)) + time_offset
        s_text = str(_attr(s, "text", "")).strip()

        # Match words to this segment by their original (unoffset) times.
        orig_start = float(_attr(s, "start", 0.0))
        orig_end = float(_attr(s, "end", 0.0))
        words = [
            Word(
                text=str(_attr(w, "word", "")),
                start=float(_attr(w, "start", 0.0)) + time_offset,
                end=float(_attr(w, "end", 0.0)) + time_offset,
            )
            for w in raw_words
            if orig_start <= float(_attr(w, "start", 0.0)) < orig_end
        ]
        out.append(
            TranscriptSegment(
                id=int(_attr(s, "id", i)),
                start=s_start,
                end=s_end,
                text=s_text,
                words=words,
                avg_logprob=(
                    float(_attr(s, "avg_logprob"))
                    if _attr(s, "avg_logprob") is not None
                    else None
                ),
                no_speech_prob=(
                    float(_attr(s, "no_speech_prob"))
                    if _attr(s, "no_speech_prob") is not None
                    else None
                ),
            )
        )
    return out


def _call_groq(file_path: Path, client, language: str | None):
    with file_path.open("rb") as f:
        return client.audio.transcriptions.create(
            file=(file_path.name, f.read()),
            model=GROQ_MODEL,
            response_format="verbose_json",
            timestamp_granularities=["word", "segment"],
            language=language,
        )


# ─── groq backend ─────────────────────────────────────────────────────────────


def transcribe_groq(
    audio_path: Path,
    language: str | None = None,
    progress=None,
) -> tuple[list[TranscriptSegment], str, float, float]:
    """Transcribe via Groq's hosted whisper-large-v3.

    For audio under the upload limit (Opus-compressed), this is a single API
    call. For longer audio, the compressed file is sliced at silence boundaries
    into N chunks, each chunk is transcribed independently, and the results
    are stitched together with their original-timeline timestamps.
    """
    from groq import Groq

    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GROQ_API_KEY is not set. Add it to .env (see .env.example) or "
            "switch to the 'local' backend."
        )

    work_dir = Path(tempfile.mkdtemp(prefix="ve_groq_"))

    if progress:
        progress(0.0, "Compressing audio to Opus 64 kbps for upload...")
    compressed = _compress_to_opus(audio_path, work_dir)
    size = compressed.stat().st_size
    duration = _audio_duration(audio_path)

    client = Groq(api_key=api_key)
    all_segments: list[TranscriptSegment] = []
    language_code = language or "en"

    if size <= GROQ_MAX_BYTES:
        if progress:
            progress(0.1, f"Uploading {size / 1_048_576:.1f} MB to Groq...")
        resp = _call_groq(compressed, client, language)
        all_segments = _parse_groq_response(resp, time_offset=0.0)
        language_code = str(_attr(resp, "language", language_code))
    else:
        # Need to chunk. Figure out how many chunks at the target bitrate.
        num_chunks = max(2, math.ceil(size / CHUNK_TARGET_BYTES))
        if progress:
            progress(
                0.05,
                f"Audio is {size / 1_048_576:.1f} MB — splitting into "
                f"{num_chunks} silence-aligned chunks for Groq...",
            )

        silences = _detect_silences(compressed)
        splits = _pick_split_points(duration, silences, num_chunks)
        chunks = _slice_audio(compressed, splits, work_dir)

        for idx, (chunk_path, offset) in enumerate(chunks):
            chunk_size_mb = chunk_path.stat().st_size / 1_048_576
            if progress:
                frac = 0.1 + (idx / len(chunks)) * 0.85
                progress(
                    frac,
                    f"Uploading chunk {idx + 1}/{len(chunks)} "
                    f"({chunk_size_mb:.1f} MB, offset {offset:.1f}s)...",
                )
            resp = _call_groq(chunk_path, client, language)
            all_segments.extend(_parse_groq_response(resp, time_offset=offset))
            # First chunk's detected language wins.
            if idx == 0:
                language_code = str(_attr(resp, "language", language_code))

        # Re-number segment ids contiguously since each chunk started from 0.
        for new_id, seg in enumerate(all_segments):
            seg.id = new_id

    if progress:
        progress(1.0, f"Groq returned {len(all_segments)} segments")

    # Language probability isn't exposed by Groq; report 1.0 if forced, else 0.0.
    lang_prob = 1.0 if language else 0.0
    return all_segments, str(language_code), lang_prob, duration


# ─── local backend (faster-whisper) ───────────────────────────────────────────


def _fmt_t(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f"{m:02d}:{s:02d}"


def transcribe_local(
    audio_path: Path,
    model_size: WhisperModelSize = "large-v3",
    compute_type: ComputeType = "int8",
    language: str | None = None,
    beam_size: int = 5,
    progress=None,
) -> tuple[list[TranscriptSegment], str, float, float]:
    """Transcribe locally via faster-whisper (ctranslate2 on CPU)."""
    device = "cuda" if torch.cuda.is_available() else "cpu"

    if progress:
        progress(0.0, f"Loading Whisper {model_size} ({compute_type})...")
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    if progress:
        progress(0.0, "Starting transcription...")
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=language,
        beam_size=beam_size,
        word_timestamps=True,
        vad_filter=False,
        condition_on_previous_text=True,
    )
    total = float(info.duration) or 1.0

    out: list[TranscriptSegment] = []
    for s in segments_iter:
        if progress:
            frac = min(max(float(s.end) / total, 0.0), 1.0)
            progress(frac, f"Transcribing: {_fmt_t(s.end)} / {_fmt_t(total)}")
        words = [
            Word(
                text=w.word,
                start=float(w.start),
                end=float(w.end),
                probability=(
                    float(w.probability) if w.probability is not None else None
                ),
            )
            for w in (s.words or [])
        ]
        out.append(
            TranscriptSegment(
                id=s.id,
                start=float(s.start),
                end=float(s.end),
                text=s.text,
                words=words,
                avg_logprob=(
                    float(s.avg_logprob) if s.avg_logprob is not None else None
                ),
                no_speech_prob=(
                    float(s.no_speech_prob) if s.no_speech_prob is not None else None
                ),
            )
        )
    if progress:
        progress(1.0, f"Transcribed {len(out)} segments")
    return out, info.language, float(info.language_probability), float(info.duration)
