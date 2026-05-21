"""Stage 5 — render a `CutPlan` to a YouTube-ready MP4.

Takes the source video and the stage-4 ``CutPlan``; produces an MP4 (H.264 +
AAC) with the keep-segments concatenated in order and short audio fades on each
side of every cut so the joins are click-free.

## Cut technique

For each keep-segment we emit two filter chains:

- **Video**: ``[0:v]trim=start..end,setpts=PTS-STARTPTS[vN]`` — hard cut.
- **Audio**: ``[0:a:T]atrim=start..end,asetpts=PTS-STARTPTS,
  afade=in,afade=out[aN]`` — split the requested crossfade in half, fade audio
  *out* over the trailing N/2 ms of the segment, *in* over the leading N/2 ms.

Then concat all chains: ``[v0][a0][v1][a1]...concat=n=N:v=1:a=1``.

Why fade-out/fade-in rather than ``acrossfade``? ``acrossfade`` introduces a
time overlap between adjacent audio segments — the audio ends up shorter than
the sum of inputs, so video and audio desync unless you also overlap the video
segments. With per-segment fades, both tracks stay frame-aligned and there's
no sync math to get wrong.

## Quality vs. speed

Defaults (libx264 ``-preset slow -crf 18`` + AAC 192k) are the
visually-near-lossless YouTube target. Slow but worth it. Caller can override
``crf`` and ``preset`` if they're willing to trade quality for time.
"""

from __future__ import annotations

import re
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

from .models import CutPlan

ProgressFn = Callable[[float, str], None]


class RenderError(RuntimeError):
    pass


def _build_filter_graph(plan: CutPlan, audio_track_index: int) -> str:
    """Build the FFmpeg filter_complex graph for the cut plan."""
    n = len(plan.keeps)
    half_xfade = (plan.params.crossfade_ms / 2) / 1000.0

    lines: list[str] = []
    for i, k in enumerate(plan.keeps):
        # Video: trim + reset PTS. Hard cut.
        lines.append(
            f"[0:v]trim=start={k.source_start:.6f}:end={k.source_end:.6f},"
            f"setpts=PTS-STARTPTS[v{i}]"
        )
        # Audio: trim + reset PTS + fade in + fade out. Each fade is half the
        # requested crossfade; cap to a quarter of the segment so super-short
        # keeps don't collapse to silence.
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

    # Concat everything.
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


def render(
    source: Path,
    plan: CutPlan,
    output_path: Path,
    audio_track_index: int = 0,
    video_crf: int = 18,
    video_preset: str = "slow",
    audio_bitrate: str = "192k",
    progress: ProgressFn | None = None,
) -> Path:
    """Render the source video according to the cut plan."""
    if not source.exists():
        raise RenderError(f"source not found: {source}")
    if not plan.keeps:
        raise RenderError("plan has no keep-segments — nothing to render")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    if progress:
        progress(0.0, f"Building filter graph for {len(plan.keeps)} segments...")

    filter_graph = _build_filter_graph(plan, audio_track_index)

    # Long graphs (hundreds of segments) can exceed shell command-line limits.
    # Write to a temp file and reference via -filter_complex_script.
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
            "-c:v", "libx264",
            "-preset", video_preset,
            "-crf", str(video_crf),
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", audio_bitrate,
            "-movflags", "+faststart",
            "-progress", "pipe:1",
            str(output_path),
        ]

        if progress:
            progress(
                0.02,
                f"Encoding {plan.output_duration:.1f}s output "
                f"(libx264 {video_preset}, CRF {video_crf})...",
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
        # Drain stderr regardless of success, for logging on failure.
        if proc.stderr is not None:
            stderr_tail = proc.stderr.read().splitlines()[-40:]

        if rc != 0:
            raise RenderError(
                f"ffmpeg failed (exit {rc}). Last stderr:\n"
                + "\n".join(stderr_tail)
            )

        if progress:
            size_mb = output_path.stat().st_size / 1_048_576
            progress(1.0, f"Done — {output_path.name} ({size_mb:.1f} MB)")
    finally:
        graph_path.unlink(missing_ok=True)

    return output_path
