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


def _build_filter_graph(plan: CutPlan, audio_track_index: int) -> str:
    """Build the FFmpeg filter_complex graph for the cut plan."""
    n = len(plan.keeps)
    half_xfade = (plan.params.crossfade_ms / 2) / 1000.0

    lines: list[str] = []
    for i, k in enumerate(plan.keeps):
        lines.append(
            f"[0:v]trim=start={k.source_start:.6f}:end={k.source_end:.6f},"
            f"setpts=PTS-STARTPTS[v{i}]"
        )
        keep_dur = k.duration
        actual_fade = max(min(half_xfade, keep_dur / 4), 0.001)
        fade_out_st = max(keep_dur - actual_fade, 0.0)
        lines.append(
            f"[0:a:{audio_track_index}]"
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

    if progress:
        progress(
            0.0,
            f"Building filter graph for {len(plan.keeps)} segments "
            f"(encoder: {resolved_encoder})...",
        )

    filter_graph = _build_filter_graph(plan, audio_track_index)
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", delete=False, prefix="ve_filter_",
    ) as f:
        f.write(filter_graph)
        graph_path = Path(f.name)

    try:
        cmd = [
            "ffmpeg", "-y",
            "-hide_banner", "-loglevel", "warning",
            "-i", str(source),
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
                f"Encoding {plan.output_duration:.1f}s output ({resolved_encoder})...",
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
