"""Where pipeline artifacts go.

One source of truth for every file the pipeline writes: probe / analysis JSON,
classification JSON, plan JSON, rendered MP4, intermediate mic WAV.

Layout — **per-source subdirectory** under the configured output root:

```
<CADENCE_OUTPUT_DIR or ./files>/
├── recording-2026-05-21/
│   ├── recording-2026-05-21.mov              (if uploaded; original location
│   │                                          preserved if path-input)
│   ├── recording-2026-05-21.analysis.json
│   ├── recording-2026-05-21.classified.json
│   ├── recording-2026-05-21.plan.json
│   ├── recording-2026-05-21.edited.mp4
│   └── recording-2026-05-21.mic.16k.wav
├── episode-12/
│   └── ...
```

Why per-source: with the flat layout, every new project added five-plus files
to a single directory. After three projects you stop being able to scan the
folder. Per-source means each project's artifacts live together — easy to
delete, easy to back up, easy to share.

All path helpers return *absolute* paths. Relative paths bite the moment
something running in a different cwd needs to open them (e.g. the sidecar
when launched via Tauri or systemd).
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

_DEFAULT_OUTPUT_DIR = Path("files")
_ENV_VAR = "CADENCE_OUTPUT_DIR"


def output_dir() -> Path:
    """Return (and create) the *root* output directory.

    Typically you want :func:`project_dir` instead — that returns the per-source
    subdir where the actual artifacts live. ``output_dir`` is only useful when
    you need to scan across projects (e.g. for the migration command) or are
    looking up a file by full path that was already qualified.
    """
    base_str = os.getenv(_ENV_VAR, "").strip()
    base = Path(base_str).expanduser() if base_str else _DEFAULT_OUTPUT_DIR
    base.mkdir(parents=True, exist_ok=True)
    return base.resolve()


def project_dir(source: Path) -> Path:
    """Return (and create) the per-source project directory.

    Keyed by the source file's stem — ``recording.mov`` → ``files/recording/``.
    Used by every per-stage path helper below.
    """
    out = output_dir() / source.stem
    out.mkdir(parents=True, exist_ok=True)
    return out


# ─── Per-stage path helpers ──────────────────────────────────────────────────


def analysis_path(source: Path) -> Path:
    return project_dir(source) / f"{source.stem}.analysis.json"


def classified_path(source: Path) -> Path:
    return project_dir(source) / f"{source.stem}.classified.json"


def plan_path(source: Path) -> Path:
    return project_dir(source) / f"{source.stem}.plan.json"


def rendered_path(
    source: Path,
    enhance_speech: str = "off",
    auto_duck: bool = False,
    ducking_db: int = -8,
    source_audio_track_count: int = 1,
) -> Path:
    """Output path for a rendered MP4.

    Audio settings are encoded into the filename so different combinations
    coexist on disk and can be A/B compared. Examples:

        recording.edited.mp4                            # pacing only
        recording.edited.enhance-medium.mp4             # + speech enhance
        recording.edited.enhance-high.duck-8.mp4        # + ducking

    Ducking only contributes to the filename when it would actually run
    (source has 2+ audio tracks) — otherwise it's a no-op and shouldn't
    affect the output name.
    """
    parts = [source.stem, "edited"]
    if enhance_speech != "off":
        parts.append(f"enhance-{enhance_speech}")
    if auto_duck and source_audio_track_count > 1:
        parts.append(f"duck{ducking_db}")
    return project_dir(source) / (".".join(parts) + ".mp4")


def mic_wav_path(source: Path) -> Path:
    return project_dir(source) / f"{source.stem}.mic.16k.wav"


# ─── Backward-compat: legacy flat-layout lookups ─────────────────────────────


def legacy_flat_path(source: Path, suffix: str) -> Path:
    """The path an artifact *would* have been at under the pre-2026-05-21
    flat layout. Used by the probe response to keep old projects discoverable
    without forcing a migration."""
    return output_dir() / f"{source.stem}{suffix}"
