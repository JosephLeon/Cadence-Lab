"""CLI entrypoint for the video editor.

Currently exposes three commands:

  video-editor probe <video>       — inspect audio tracks (use this to find the
                                     mic track before running `analyze`)
  video-editor analyze <video>     — full ingest + speech analysis pass; writes
                                     a structured JSON bundle to disk
  video-editor ui                  — launch the Streamlit UI
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

from .ingest import ingest, probe
from .models import AnalysisBundle
from .speech import ComputeType, WhisperModelSize, analyze

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
    model: Annotated[
        WhisperModelSize, typer.Option(help="Whisper model size.")
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

    with console.status(f"[bold cyan]Transcribing with Whisper {model} ({compute_type})..."):
        speech = analyze(
            audio_path=ing.normalized_audio_path,
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
