"""Stage 5 — render a `CutPlan` to a YouTube-ready MP4.

Takes the source video and the stage-4 ``CutPlan``; produces an MP4 (H.264 +
AAC) with the keep-segments concatenated in order and short audio fades on each
side of every cut so the joins are click-free.

## Encoder choice (this is the speed/quality dial)

Two paths:

- **auto** (default): ``h264_videotoolbox`` — Apple Silicon's hardware encoder.
  10–30× faster than libx264 on the same machine, visually indistinguishable
  for screen-recording content delivered to YouTube. We set ``-q:v 65`` plus
  ``-realtime 0 -prio_speed 0 -profile:v high`` so the hardware encoder takes
  its time for best compression instead of running in low-latency mode.
  Falls back to libx264 if videotoolbox isn't available on the platform.

- **libx264** (opt-in "archival" mode): software encoder at ``-preset slow
  -crf 18``. Visually near-lossless. Useful when you want a CPU master that
  doesn't depend on the Apple Silicon hardware engine — but for YouTube
  delivery the bits are wasted, since YouTube re-encodes to VP9/AV1 anyway.

## Cut technique (same for both encoders)

For each keep-segment we emit two filter chains:

- **Video**: ``[0:v]trim=start..end,setpts=PTS-STARTPTS[vN]`` — hard cut.
- **Audio**: ``[0:a:T]atrim=start..end,asetpts=PTS-STARTPTS,
  afade=in,afade=out[aN]`` — split the requested crossfade in half, fade audio
  *out* over the trailing N/2 ms of the segment, *in* over the leading N/2 ms.

Then concat all chains: ``[v0][a0][v1][a1]...concat=n=N:v=1:a=1``.

Why per-segment fades rather than ``acrossfade``? ``acrossfade`` introduces a
time overlap between adjacent audio segments — the audio ends up shorter than
the sum of inputs, so video and audio desync unless you also overlap the video
segments. With per-segment fades, both tracks stay frame-aligned.
"""

from __future__ import annotations

import functools
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal

from .models import CutPlan

ProgressFn = Callable[[float, str], None]


class RenderError(RuntimeError):
    pass


EncoderChoice = Literal["auto", "h264_videotoolbox", "libx264"]


# ─── Encoder detection / arg construction ────────────────────────────────────


@functools.lru_cache(maxsize=1)
def _supports_videotoolbox() -> bool:
    """Check whether ffmpeg has the ``h264_videotoolbox`` encoder compiled in."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return False
    return "h264_videotoolbox" in proc.stdout


def _resolve_encoder(choice: EncoderChoice) -> str:
    if choice == "auto":
        return "h264_videotoolbox" if _supports_videotoolbox() else "libx264"
    if choice == "h264_videotoolbox" and not _supports_videotoolbox():
        # Caller asked for VT but it isn't available; raise a clear error
        # rather than silently falling back to a much slower encoder.
        raise RenderError(
            "h264_videotoolbox is not available in your ffmpeg build. "
            "Use --encoder auto (recommended) or --encoder libx264."
        )
    return choice


def _encoder_args(encoder: str) -> list[str]:
    """Return the video-encoder flags for the given encoder name."""
    if encoder == "h264_videotoolbox":
        # -q:v 65 ≈ libx264 CRF 19-20 for typical content. Plenty for YouTube,
        # which transcodes everything anyway.
        # -realtime 0 and -prio_speed 0 tell videotoolbox it's OK to spend
        # more time on each frame in exchange for better compression.
        return [
            "-c:v", "h264_videotoolbox",
            "-q:v", "65",
            "-realtime", "0",
            "-prio_speed", "0",
            "-profile:v", "high",
            "-pix_fmt", "yuv420p",
        ]
    if encoder == "libx264":
        # Archival-quality CPU encode. Reserved for cases where the hardware
        # encoder is genuinely unsuitable; for YouTube delivery this is overkill.
        return [
            "-c:v", "libx264",
            "-preset", "slow",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
        ]
    raise RenderError(f"Unknown encoder: {encoder!r}")


# ─── Filter graph + progress parsing ─────────────────────────────────────────


SpeechEnhanceLevel = Literal["off", "low", "medium", "high"]


def _enhancement_chain(level: SpeechEnhanceLevel) -> str:
    """Audio-domain ffmpeg filters for the given enhancement strength.

    Applied to the *continuous* source audio before cuts are made — denoise
    algorithms work better with full context than spliced segments.

    - **low**: rumble removal + EBU R128 loudness normalization. Cleanup
      every recording benefits from with essentially no risk.
    - **medium**: + adaptive FFT denoise (gentle) — kills hum / room noise
      without artifacting on voice.
    - **high**: + aggressive denoise + de-essing. Best for noisy rooms; can
      thin the voice slightly on already-clean recordings.

    Returns an ffmpeg filter chain (comma-separated), or empty string for "off".
    Loudness target is YouTube's -14 LUFS post-normalization sweet spot.
    """
    if level == "off":
        return ""
    if level == "low":
        return "highpass=f=80,loudnorm=I=-14:TP=-1.5:LRA=11"
    if level == "medium":
        return (
            "highpass=f=80,"
            "afftdn=nr=10:nf=-25,"
            "loudnorm=I=-14:TP=-1.5:LRA=11"
        )
    if level == "high":
        # afftdn more aggressive + a deesser to tame sibilance the denoise
        # tends to push forward.
        return (
            "highpass=f=80,"
            "afftdn=nr=20:nf=-30,"
            "deesser,"
            "loudnorm=I=-14:TP=-1.5:LRA=11"
        )
    return ""


def _build_filter_graph(
    plan: CutPlan,
    audio_track_index: int,
    enhance_speech: SpeechEnhanceLevel = "off",
    auto_duck: bool = False,
    ducking_db: int = -8,
    source_audio_track_count: int = 1,
    audio_input_index: int = 0,
) -> str:
    """Build the FFmpeg filter_complex graph for the cut plan.

    The audio pipeline (when audio processing is on) is:

      Source audio
        ↓
      Speech enhancement (applied to continuous signal — best for denoise)
        ↓
      Auto-ducking (only when source has 2+ audio tracks)
        ↓
      asplit N ways for N keep-segments
        ↓
      Per-segment atrim + fade-in/out
        ↓
      Concat with video

    When no audio processing is enabled, we keep the original direct-input
    path (slightly more efficient — input pads can be referenced multiple
    times without an explicit asplit).
    """
    n = len(plan.keeps)
    half_xfade = (plan.params.crossfade_ms / 2) / 1000.0
    enhance_chain = _enhancement_chain(enhance_speech)
    do_duck = auto_duck and source_audio_track_count > 1
    audio_processed = bool(enhance_chain) or do_duck

    lines: list[str] = []

    # ─── Audio prologue: build the labeled "full audio" stream ────────────
    if audio_processed:
        # Step 1: enhance the mic track (or leave raw if no enhancement)
        mic_in = f"[{audio_input_index}:a:{audio_track_index}]"
        if enhance_chain:
            lines.append(f"{mic_in}{enhance_chain}[mic_clean]")
            mic_label = "[mic_clean]"
        else:
            # Need a labeled stream for asplit downstream; alias the input.
            lines.append(f"{mic_in}anull[mic_clean]")
            mic_label = "[mic_clean]"

        # Step 2: optional ducking — pick first non-mic track as the "other"
        if do_duck:
            other_track = 0 if audio_track_index != 0 else 1
            lines.append(f"[0:a:{other_track}]anull[other_in]")
            # sidechaincompress: first input is what gets compressed,
            # second is the trigger. We want the other track to be lowered
            # when the mic has signal — so other is first, mic is sidechain.
            # The `makeup` parameter controls how much we boost after
            # compression; we set it so net effect ≈ ducking_db.
            lines.append(
                f"[other_in]{mic_label}"
                f"sidechaincompress="
                f"threshold=0.05:ratio=8:attack=20:release=200:makeup=0"
                f"[other_ducked]"
            )
            # Mix mic (unducked, at full volume) with ducked-other
            lines.append(
                f"{mic_label}[other_ducked]"
                f"amix=inputs=2:duration=longest:dropout_transition=0"
                f"[a_full]"
            )
            full_label = "[a_full]"
        else:
            full_label = mic_label

        # Step 3: asplit so each keep-segment trim has its own input
        split_outs = "".join(f"[a_src_{i}]" for i in range(n))
        lines.append(f"{full_label}asplit={n}{split_outs}")
        audio_inputs = [f"[a_src_{i}]" for i in range(n)]
    else:
        # Direct-input path — input pads can be referenced N times for free
        audio_inputs = [f"[{audio_input_index}:a:{audio_track_index}]" for _ in range(n)]

    # ─── Per-segment trim + fade ──────────────────────────────────────────
    for i, k in enumerate(plan.keeps):
        lines.append(
            f"[0:v]trim=start={k.source_start:.6f}:end={k.source_end:.6f},"
            f"setpts=PTS-STARTPTS[v{i}]"
        )
        keep_dur = k.duration
        actual_fade = max(min(half_xfade, keep_dur / 4), 0.001)
        fade_out_st = max(keep_dur - actual_fade, 0.0)
        lines.append(
            f"{audio_inputs[i]}"
            f"atrim=start={k.source_start:.6f}:end={k.source_end:.6f},"
            f"asetpts=PTS-STARTPTS,"
            f"afade=t=in:st=0:d={actual_fade:.6f},"
            f"afade=t=out:st={fade_out_st:.6f}:d={actual_fade:.6f}"
            f"[a{i}]"
        )

    inputs = "".join(f"[v{i}][a{i}]" for i in range(n))
    lines.append(f"{inputs}concat=n={n}:v=1:a=1[v_out][a_out]")
    return ";\n".join(lines)


def _parse_out_time(line: str) -> float | None:
    """Parse an ``out_time=HH:MM:SS.ffffff`` line from ffmpeg -progress."""
    if not line.startswith("out_time="):
        return None
    val = line[len("out_time="):].strip()
    if val == "N/A" or not val:
        return None
    try:
        h, m, s = val.split(":")
        return int(h) * 3600 + int(m) * 60 + float(s)
    except (ValueError, IndexError):
        return None


# ─── Top-level render ────────────────────────────────────────────────────────


def render(
    source: Path,
    plan: CutPlan,
    output_path: Path,
    audio_track_index: int = 0,
    encoder: EncoderChoice = "auto",
    audio_bitrate: str = "192k",
    enhance_speech: SpeechEnhanceLevel = "off",
    auto_duck: bool = False,
    ducking_db: int = -8,
    source_audio_track_count: int = 1,
    external_audio_path: Path | None = None,
    progress: ProgressFn | None = None,
) -> Path:
    """Render the source video according to the cut plan.

    Encoder choice is the dominant speed/quality dial:

    - ``"auto"`` (default): uses ``h264_videotoolbox`` if available (Apple
      Silicon hardware encoder), else falls back to libx264. Best speed,
      visually indistinguishable for YouTube delivery.
    - ``"h264_videotoolbox"``: explicit hardware encode. Errors if unavailable.
    - ``"libx264"``: software encode at ``-preset slow -crf 18``. Maximum
      quality but 10–30× slower; usually unnecessary for YouTube.
    """
    if not source.exists():
        raise RenderError(f"source not found: {source}")
    if not plan.keeps:
        raise RenderError("plan has no keep-segments — nothing to render")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_encoder = _resolve_encoder(encoder)

    audio_note = ""
    if enhance_speech != "off":
        audio_note += f", speech enhance: {enhance_speech}"
    if auto_duck and source_audio_track_count > 1:
        audio_note += f", duck: {ducking_db}dB"

    if progress:
        progress(
            0.0,
            f"Building filter graph for {len(plan.keeps)} segments "
            f"(encoder: {resolved_encoder}{audio_note})...",
        )

    # When external_audio_path is set, route the audio input to a second
    # ffmpeg -i (input index 1) instead of the source's audio track. The
    # video is still input 0. This is how neural-denoised audio gets
    # spliced in — DFN runs as a pre-pass, output WAV becomes the audio
    # source for the encode.
    use_external_audio = external_audio_path is not None
    if use_external_audio:
        audio_input_index = 1
        # External WAV is mono speech — single track, index 0.
        effective_track_index = 0
        # The audio passed in IS the denoised output already; skip the
        # in-graph afftdn chain to avoid double-processing.
        effective_enhance = "off"
    else:
        audio_input_index = 0
        effective_track_index = audio_track_index
        effective_enhance = enhance_speech

    filter_graph = _build_filter_graph(
        plan,
        effective_track_index,
        enhance_speech=effective_enhance,
        auto_duck=auto_duck,
        ducking_db=ducking_db,
        source_audio_track_count=source_audio_track_count,
        audio_input_index=audio_input_index,
    )
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", delete=False, prefix="ve_filter_",
    ) as f:
        f.write(filter_graph)
        graph_path = Path(f.name)

    try:
        input_args: list[str] = ["-i", str(source)]
        if use_external_audio:
            input_args += ["-i", str(external_audio_path)]
        cmd = [
            "ffmpeg", "-y",
            "-hide_banner", "-loglevel", "warning",
            *input_args,
            "-filter_complex_script", str(graph_path),
            "-map", "[v_out]",
            "-map", "[a_out]",
            *_encoder_args(resolved_encoder),
            "-c:a", "aac",
            "-b:a", audio_bitrate,
            "-movflags", "+faststart",
            "-progress", "pipe:1",
            str(output_path),
        ]

        if progress:
            progress(
                0.02,
                f"Encoding {plan.output_duration:.1f}s output ({resolved_encoder}{audio_note})...",
            )

        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )

        expected_seconds = plan.output_duration if plan.output_duration > 0 else 1.0
        assert proc.stdout is not None
        stderr_tail: list[str] = []
        for line in proc.stdout:
            t = _parse_out_time(line)
            if t is not None and progress:
                frac = min(t / expected_seconds, 0.99)
                progress(
                    frac,
                    f"Encoding... {t:.1f}s / {plan.output_duration:.1f}s "
                    f"({frac * 100:.0f}%)",
                )
            if line.strip() == "progress=end":
                break

        rc = proc.wait()
        if proc.stderr is not None:
            stderr_tail = proc.stderr.read().splitlines()[-40:]

        if rc != 0:
            raise RenderError(
                f"ffmpeg failed (exit {rc}, encoder={resolved_encoder}). "
                f"Last stderr:\n" + "\n".join(stderr_tail)
            )

        if progress:
            size_mb = output_path.stat().st_size / 1_048_576
            progress(
                1.0,
                f"Done — {output_path.name} "
                f"({size_mb:.1f} MB, {resolved_encoder})",
            )
    finally:
        graph_path.unlink(missing_ok=True)

    return output_path


# ─── Splice render (multi-clip assembly) ─────────────────────────────────────


@dataclass
class SpliceClipSpec:
    """One entry in a splice timeline.

    - ``kind="video"``: ``source_path`` plus ``source_start``/``source_end``
      define the sub-range of the source to include.
    - ``kind="blank"``: ``duration`` seconds of black video + silent audio.
    """
    kind: Literal["video", "blank"]
    source_path: Path | None = None
    source_start: float = 0.0
    source_end: float = 0.0
    duration: float = 0.0

    def length(self) -> float:
        return self.source_end - self.source_start if self.kind == "video" else self.duration


def splice_render(
    clips: list[SpliceClipSpec],
    output_path: Path,
    *,
    target_width: int = 1920,
    target_height: int = 1080,
    target_fps: int = 30,
    encoder: EncoderChoice = "auto",
    audio_bitrate: str = "192k",
    progress: ProgressFn | None = None,
) -> Path:
    """Concatenate the given clips into a single MP4.

    Every input is normalized to the target resolution + fps + stereo 48k
    audio before concat, so mismatched sources combine cleanly. Blank spans
    are synthesized as `color=c=black` video + `anullsrc` audio at the same
    target geometry.

    Per-segment audio fades are applied at every join (not just video/blank
    joins) so cuts between videos with different ambient floors are
    click-free.
    """
    if not clips:
        raise RenderError("splice render: no clips supplied")
    for c in clips:
        if c.kind == "video":
            if not c.source_path or not Path(c.source_path).exists():
                raise RenderError(f"source not found: {c.source_path}")
        if c.length() <= 0:
            raise RenderError(f"zero-length clip in splice ({c})")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_encoder = _resolve_encoder(encoder)
    total = sum(c.length() for c in clips)

    if progress:
        progress(
            0.0,
            f"Building splice graph for {len(clips)} clips "
            f"({total:.1f}s total, encoder: {resolved_encoder})...",
        )

    # Build -i input flags + record each clip's input index. Blank clips
    # consume two inputs (video + audio); video clips consume one.
    input_args: list[str] = []
    # For each clip, store (video_input_index, audio_input_index).
    clip_inputs: list[tuple[int, int]] = []
    next_idx = 0
    for c in clips:
        if c.kind == "video":
            input_args += ["-i", str(c.source_path)]
            clip_inputs.append((next_idx, next_idx))
            next_idx += 1
        else:
            input_args += [
                "-f", "lavfi",
                "-i", f"color=c=black:s={target_width}x{target_height}:r={target_fps}:d={c.duration:.6f}",
                "-f", "lavfi",
                "-i", f"anullsrc=channel_layout=stereo:sample_rate=48000:d={c.duration:.6f}",
            ]
            clip_inputs.append((next_idx, next_idx + 1))
            next_idx += 2

    # Per-clip filter chains: trim + normalize + per-end fades.
    HALF_FADE = 0.0075  # 15ms total — matches the AI-pacing renderer
    lines: list[str] = []
    for i, (c, (vi, ai)) in enumerate(zip(clips, clip_inputs)):
        dur = c.length()
        fade = max(min(HALF_FADE, dur / 4), 0.001)
        fade_out_st = max(dur - fade, 0.0)
        if c.kind == "video":
            lines.append(
                f"[{vi}:v]trim=start={c.source_start:.6f}:end={c.source_end:.6f},"
                f"setpts=PTS-STARTPTS,"
                f"scale={target_width}:{target_height}:force_original_aspect_ratio=decrease,"
                f"pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2:color=black,"
                f"fps={target_fps},setsar=1[v{i}]"
            )
            lines.append(
                f"[{ai}:a]atrim=start={c.source_start:.6f}:end={c.source_end:.6f},"
                f"asetpts=PTS-STARTPTS,"
                f"aformat=sample_rates=48000:channel_layouts=stereo,"
                f"afade=t=in:st=0:d={fade:.6f},"
                f"afade=t=out:st={fade_out_st:.6f}:d={fade:.6f}[a{i}]"
            )
        else:
            # Blank inputs come from lavfi already at the right geometry; just
            # relabel and add the same fade pattern for consistent joins.
            lines.append(f"[{vi}:v]setpts=PTS-STARTPTS,setsar=1[v{i}]")
            lines.append(
                f"[{ai}:a]asetpts=PTS-STARTPTS,"
                f"afade=t=in:st=0:d={fade:.6f},"
                f"afade=t=out:st={fade_out_st:.6f}:d={fade:.6f}[a{i}]"
            )

    concat_inputs = "".join(f"[v{i}][a{i}]" for i in range(len(clips)))
    lines.append(f"{concat_inputs}concat=n={len(clips)}:v=1:a=1[v_out][a_out]")
    filter_graph = ";\n".join(lines)

    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", delete=False, prefix="ve_splice_",
    ) as f:
        f.write(filter_graph)
        graph_path = Path(f.name)

    try:
        cmd = [
            "ffmpeg", "-y",
            "-hide_banner", "-loglevel", "warning",
            *input_args,
            "-filter_complex_script", str(graph_path),
            "-map", "[v_out]",
            "-map", "[a_out]",
            *_encoder_args(resolved_encoder),
            "-c:a", "aac",
            "-b:a", audio_bitrate,
            "-movflags", "+faststart",
            "-progress", "pipe:1",
            str(output_path),
        ]

        if progress:
            progress(
                0.02,
                f"Encoding {total:.1f}s assembly ({resolved_encoder})...",
            )

        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        expected = total if total > 0 else 1.0
        assert proc.stdout is not None
        stderr_tail: list[str] = []
        for line in proc.stdout:
            t = _parse_out_time(line)
            if t is not None and progress:
                frac = min(t / expected, 0.99)
                progress(
                    frac,
                    f"Encoding... {t:.1f}s / {total:.1f}s ({frac * 100:.0f}%)",
                )
            if line.strip() == "progress=end":
                break

        rc = proc.wait()
        if proc.stderr is not None:
            stderr_tail = proc.stderr.read().splitlines()[-40:]

        if rc != 0:
            raise RenderError(
                f"ffmpeg failed (exit {rc}, encoder={resolved_encoder}). "
                f"Last stderr:\n" + "\n".join(stderr_tail)
            )

        if progress:
            size_mb = output_path.stat().st_size / 1_048_576
            progress(
                1.0,
                f"Done — {output_path.name} ({size_mb:.1f} MB, {resolved_encoder})",
            )
    finally:
        graph_path.unlink(missing_ok=True)

    return output_path
