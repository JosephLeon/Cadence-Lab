"""Where pipeline artifacts go.

One source of truth for every file the pipeline writes: probe / analysis JSON,
classification JSON, plan JSON, rendered MP4, intermediate mic WAV.

Default destination is ``./files/`` (project-relative). Override with the
``CADENCE_OUTPUT_DIR`` environment variable — useful if you keep videos on
an external drive but want outputs on local disk, or you want one central
location for many projects.

Naming is *flat by stem* — all artifacts for ``recording.mov`` land as
``recording.analysis.json`` / ``recording.classified.json`` / etc. in the
same directory. No per-source subdirectories — they add a level of nesting
that isn't worth it until you're juggling hundreds of projects.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

_DEFAULT_OUTPUT_DIR = Path("files")
_ENV_VAR = "CADENCE_OUTPUT_DIR"


def output_dir() -> Path:
    """Return (and create) the directory where pipeline artifacts go.

    Reads ``CADENCE_OUTPUT_DIR`` from the environment; falls back to
    ``./files`` so the tool works without any config on a fresh checkout.
    """
    base_str = os.getenv(_ENV_VAR, "").strip()
    base = Path(base_str).expanduser() if base_str else _DEFAULT_OUTPUT_DIR
    base.mkdir(parents=True, exist_ok=True)
    return base


# ─── Per-stage path helpers ──────────────────────────────────────────────────
# Every output path the pipeline writes goes through one of these. Keep
# additions here so renaming a stage's file is a one-line change.


def analysis_path(source: Path) -> Path:
    return output_dir() / f"{source.stem}.analysis.json"


def classified_path(source: Path) -> Path:
    return output_dir() / f"{source.stem}.classified.json"


def plan_path(source: Path) -> Path:
    return output_dir() / f"{source.stem}.plan.json"


def rendered_path(source: Path) -> Path:
    return output_dir() / f"{source.stem}.edited.mp4"


def mic_wav_path(source: Path) -> Path:
    return output_dir() / f"{source.stem}.mic.16k.wav"
