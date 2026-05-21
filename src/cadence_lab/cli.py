"""CLI entrypoint for the video editor.

Currently exposes three commands:

  cadence-lab probe <video>       — inspect audio tracks (use this to find the
                                     mic track before running `analyze`)
  cadence-lab analyze <video>     — full ingest + speech analysis pass; writes
                                     a structured JSON bundle to disk
  cadence-lab ui                  — launch the Streamlit UI
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from .classifier import classify
from .ingest import ingest, probe
from .models import (
    AnalysisBundle,
    ClassificationBundle,
    CutPlan,
    CutPlanParams,
    SpeechAnalysis,
)
from .planner import plan_cuts
from .renderer import render
from .speech import Backend, ComputeType, WhisperModelSize, analyze

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="AI-assisted editor for OBS-style screen recordings.",
)
console = Console()


@app.command("probe")
def probe_cmd(
    source: Annotated[Path, typer.Argument(exists=True, dir_okay=False, readable=True)],
) -> None:
    """Show audio tracks and basic media info for a source video."""
    p = probe(source)

    console.print(f"[bold]{p.path}[/bold]")
    console.print(
        f"  container: {p.container}    duration: {p.duration_seconds:.2f}s    "
        f"video: {p.video_codec} {p.width}x{p.height} @ {p.frame_rate}fps"
        + ("  [yellow](VFR)[/yellow]" if p.is_variable_frame_rate else "")
    )

    table = Table(title="Audio tracks", show_lines=False)
    table.add_column("idx", justify="right")
    table.add_column("codec")
    table.add_column("ch", justify="right")
    table.add_column("sr", justify="right")
    table.add_column("lang")
    table.add_column("title")
    for t in p.audio_tracks:
        table.add_row(
            str(t.index),
            t.codec,
            str(t.channels),
            str(t.sample_rate),
            t.language or "-",
            t.title or "-",
        )
    console.print(table)
    console.print(
        "[dim]Pick the mic track index for `analyze --mic-track N`.[/dim]"
    )


@app.command("analyze")
def analyze_cmd(
    source: Annotated[Path, typer.Argument(exists=True, dir_okay=False, readable=True)],
    mic_track: Annotated[
        int, typer.Option("--mic-track", "-m", help="Audio track index to treat as the mic.")
    ] = 0,
    backend: Annotated[
        Backend,
        typer.Option(help="Transcription backend: groq (hosted, fast) or local (faster-whisper)."),
    ] = "groq",
    model: Annotated[
        WhisperModelSize,
        typer.Option(help="Whisper model size (local backend only)."),
    ] = "large-v3",
    compute_type: Annotated[
        ComputeType,
        typer.Option(help="Whisper compute precision (int8 is the Apple Silicon default)."),
    ] = "int8",
    language: Annotated[
        str | None,
        typer.Option(help="Force a language code (e.g. 'en') instead of auto-detect."),
    ] = None,
    work_dir: Annotated[
        Path, typer.Option(help="Directory for intermediate WAVs.")
    ] = Path("output/work"),
    out: Annotated[
        Path | None,
        typer.Option(help="Where to write the analysis JSON (default: alongside source)."),
    ] = None,
) -> None:
    """Run ingest + speech analysis and write a JSON bundle to disk."""
    work_dir.mkdir(parents=True, exist_ok=True)

    with console.status("[bold cyan]Probing source and extracting mic audio..."):
        ing = ingest(source=source, work_dir=work_dir, mic_track_index=mic_track)
    console.print(
        f"[green]✓[/green] extracted mic track {mic_track} → "
        f"[dim]{ing.normalized_audio_path}[/dim]"
    )

    label = (
        f"Groq whisper-large-v3" if backend == "groq"
        else f"Whisper {model} ({compute_type}) [local]"
    )
    with console.status(f"[bold cyan]Transcribing with {label}..."):
        speech = analyze(
            audio_path=ing.normalized_audio_path,
            backend=backend,
            model_size=model,
            compute_type=compute_type,
            language=language,
        )
    console.print(
        f"[green]✓[/green] {speech.language} ({speech.language_probability:.2f})    "
        f"{len(speech.segments)} segments    "
        f"{sum(len(s.words) for s in speech.segments)} words    "
        f"{len(speech.vad_segments)} VAD regions"
    )

    bundle = AnalysisBundle(ingest=ing, speech=speech)
    out_path = out or source.with_suffix(".analysis.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(bundle.model_dump(mode="json"), indent=2))
    console.print(f"[green]✓[/green] wrote analysis bundle → [bold]{out_path}[/bold]")


@app.command("classify")
def classify_cmd(
    analysis_json: Annotated[
        Path,
        typer.Argument(
            exists=True, dir_okay=False, readable=True,
            help="Path to an analysis JSON produced by `analyze`.",
        ),
    ],
    min_pause_ms: Annotated[
        int,
        typer.Option(
            "--min-pause-ms",
            help="Minimum gap (ms) between words to classify as a pause.",
        ),
    ] = 250,
    out: Annotated[
        Path | None,
        typer.Option(help="Where to write the classification JSON (default: alongside input)."),
    ] = None,
) -> None:
    """Classify pauses, fillers, and retakes via Claude Opus 4.7."""
    bundle = AnalysisBundle.model_validate_json(analysis_json.read_text())
    speech: SpeechAnalysis = bundle.speech

    with console.status("[bold cyan]Classifying with Claude Opus 4.7..."):
        result: ClassificationBundle = classify(
            speech,
            min_pause_seconds=min_pause_ms / 1000.0,
        )

    out_path = out or analysis_json.with_suffix(".classified.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result.model_dump(mode="json"), indent=2))

    cls = result.classification
    cut_p = sum(1 for p in cls.pauses if p.action == "cut")
    trim_p = sum(1 for p in cls.pauses if p.action == "trim")
    keep_p = sum(1 for p in cls.pauses if p.action == "keep")
    cut_f = sum(1 for f in cls.fillers if f.action == "cut")
    console.print(
        f"[green]✓[/green] {len(cls.pauses)} pauses classified "
        f"({cut_p} cut / {trim_p} trim / {keep_p} keep), "
        f"{cut_f}/{len(cls.fillers)} fillers cut, "
        f"{len(cls.retakes)} retakes."
    )
    console.print(
        f"[dim]tokens: {result.input_tokens} in, {result.output_tokens} out "
        f"(cache_read={result.cache_read_input_tokens})[/dim]"
    )
    console.print(f"[green]✓[/green] wrote classification → [bold]{out_path}[/bold]")


@app.command("plan")
def plan_cmd(
    analysis_json: Annotated[
        Path,
        typer.Argument(
            exists=True, dir_okay=False, readable=True,
            help="Stage-2 analysis JSON (from `analyze`).",
        ),
    ],
    classified: Annotated[
        Path | None,
        typer.Option(
            "--classified",
            help="Stage-3 classified JSON. Defaults to <analysis>.classified.json.",
        ),
    ] = None,
    crossfade_ms: Annotated[int, typer.Option(help="Audio crossfade at each cut.")] = 20,
    filler_pad_ms: Annotated[int, typer.Option(help="Pad around each filler cut.")] = 20,
    default_breath_ms: Annotated[
        int, typer.Option(help="Breath trim default when classifier didn't specify."),
    ] = 150,
    min_keep_ms: Annotated[
        int, typer.Option(help="Drop keep-segments shorter than this."),
    ] = 80,
    out: Annotated[
        Path | None,
        typer.Option(help="Where to write the plan JSON (default: alongside analysis)."),
    ] = None,
) -> None:
    """Build the edit decision list (keep-segments) from analysis + classification."""
    bundle = AnalysisBundle.model_validate_json(analysis_json.read_text())
    cls_path = classified or analysis_json.with_suffix(".classified.json")
    if not cls_path.exists():
        console.print(
            f"[red]✗[/red] Classification JSON not found at [bold]{cls_path}[/bold]. "
            "Run `classify` first, or pass --classified."
        )
        raise typer.Exit(code=1)
    cls_bundle = ClassificationBundle.model_validate_json(cls_path.read_text())

    params = CutPlanParams(
        crossfade_ms=crossfade_ms,
        filler_pad_ms=filler_pad_ms,
        default_breath_ms=default_breath_ms,
        min_keep_ms=min_keep_ms,
    )

    with console.status("[bold cyan]Computing cut plan..."):
        plan: CutPlan = plan_cuts(bundle.speech, cls_bundle, params=params)

    out_path = out or analysis_json.with_suffix(".plan.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(plan.model_dump(mode="json"), indent=2))

    cuts_by_kind: dict[str, int] = {}
    removed_by_kind: dict[str, float] = {}
    for c in plan.cuts:
        cuts_by_kind[c.kind] = cuts_by_kind.get(c.kind, 0) + 1
        removed_by_kind[c.kind] = (
            removed_by_kind.get(c.kind, 0.0) + c.duration_removed
        )
    console.print(
        f"[green]✓[/green] {plan.source_duration:.1f}s → "
        f"[bold]{plan.output_duration:.1f}s[/bold]   "
        f"saved [bold]{plan.time_saved_seconds:.1f}s[/bold] "
        f"([bold]{plan.time_saved_pct:.1f}%[/bold])"
    )
    for kind in ("pause_cut", "pause_trim", "filler_cut", "retake_cut"):
        if kind in cuts_by_kind:
            console.print(
                f"  [dim]{kind:11s}[/dim] {cuts_by_kind[kind]:>4d} ops, "
                f"{removed_by_kind[kind]:.1f}s removed"
            )
    console.print(
        f"[green]✓[/green] {len(plan.keeps)} keep-segments → "
        f"[bold]{out_path}[/bold]"
    )


@app.command("render")
def render_cmd(
    analysis_json: Annotated[
        Path,
        typer.Argument(
            exists=True, dir_okay=False, readable=True,
            help="Stage-2 analysis JSON (from `analyze`).",
        ),
    ],
    plan_json: Annotated[
        Path | None,
        typer.Option(
            "--plan",
            help="Stage-4 plan JSON. Defaults to <analysis>.plan.json.",
        ),
    ] = None,
    source: Annotated[
        Path | None,
        typer.Option(
            "--source",
            help="Override source video path (default: read from analysis JSON).",
        ),
    ] = None,
    audio_track: Annotated[
        int | None,
        typer.Option(
            "--audio-track",
            help="Audio track index (default: same as ingest's mic track).",
        ),
    ] = None,
    encoder: Annotated[
        str,
        typer.Option(
            help=(
                "Video encoder: 'auto' (recommended — uses hardware encoder on "
                "Apple Silicon), 'h264_videotoolbox' (explicit hardware), or "
                "'libx264' (archival quality, ~10× slower)."
            ),
        ),
    ] = "auto",
    audio_bitrate: Annotated[str, typer.Option(help="AAC bitrate.")] = "192k",
    out: Annotated[
        Path | None,
        typer.Option(help="Output MP4 path (default: <source>.edited.mp4)."),
    ] = None,
) -> None:
    """Render the cut plan into a YouTube-ready MP4."""
    bundle = AnalysisBundle.model_validate_json(analysis_json.read_text())
    plan_path = plan_json or analysis_json.with_suffix(".plan.json")
    if not plan_path.exists():
        console.print(
            f"[red]✗[/red] Plan JSON not found at [bold]{plan_path}[/bold]. "
            "Run `plan` first, or pass --plan."
        )
        raise typer.Exit(code=1)
    plan = CutPlan.model_validate_json(plan_path.read_text())

    source_path = (source or bundle.ingest.source.path).expanduser()
    if not source_path.exists():
        console.print(f"[red]✗[/red] Source not found at [bold]{source_path}[/bold].")
        raise typer.Exit(code=1)

    track = audio_track if audio_track is not None else bundle.ingest.mic_track_index
    out_path = out or source_path.with_suffix(".edited.mp4")

    console.print(
        f"[bold]Rendering[/bold] {plan.source_duration:.1f}s → {plan.output_duration:.1f}s "
        f"(saved {plan.time_saved_pct:.1f}%) from {len(plan.keeps)} segments"
    )

    last_pct = -1
    def cli_progress(frac: float, msg: str) -> None:
        nonlocal last_pct
        pct = int(frac * 100)
        # Only emit when percentage advances or final message, to avoid spam.
        if pct > last_pct or frac >= 1.0:
            console.print(f"  [dim]{msg}[/dim]")
            last_pct = pct

    render(
        source=source_path,
        plan=plan,
        output_path=out_path,
        audio_track_index=track,
        encoder=encoder,  # type: ignore[arg-type]
        audio_bitrate=audio_bitrate,
        progress=cli_progress,
    )

    size_mb = out_path.stat().st_size / 1_048_576
    console.print(
        f"[green]✓[/green] [bold]{out_path}[/bold] "
        f"({size_mb:.1f} MB, {plan.output_duration:.1f}s, encoder: {encoder})"
    )


@app.command("ui")
def ui_cmd(
    port: Annotated[int, typer.Option(help="Port for the Streamlit server.")] = 8501,
    headless: Annotated[
        bool, typer.Option(help="Don't auto-open a browser.")
    ] = False,
) -> None:
    """Launch the Streamlit UI (upload → probe → analyze)."""
    ui_path = Path(__file__).parent / "ui.py"
    cmd = [
        sys.executable, "-m", "streamlit", "run", str(ui_path),
        "--server.port", str(port),
        "--server.maxUploadSize", "4096",  # OBS files can be multi-GB
    ]
    if headless:
        cmd += ["--server.headless", "true"]
    console.print(f"[bold cyan]Launching UI on http://localhost:{port}[/bold cyan]")
    subprocess.run(cmd, check=True)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
