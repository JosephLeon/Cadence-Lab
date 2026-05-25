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
    """Legacy output root (``<repo>/files/`` by default).

    Used only as a fallback for sources outside any workspace project.
    All real project data lives under ``projects_root()``; ephemeral caches
    live under ``cache_dir()``. New code should not write here.
    """
    base_str = os.getenv(_ENV_VAR, "").strip()
    base = Path(base_str).expanduser() if base_str else _DEFAULT_OUTPUT_DIR
    base.mkdir(parents=True, exist_ok=True)
    return base.resolve()


# ─── Cache (regenerable, never user data) ────────────────────────────────────


_DEFAULT_CACHE_DIR = (
    Path.home() / "Library" / "Caches" / "CadenceLab"
)
_CACHE_ENV_VAR = "CADENCE_CACHE_DIR"


def cache_dir() -> Path:
    """Where regenerable caches live (thumbnails, transient extractions).

    Defaults to ``~/Library/Caches/CadenceLab/`` — the standard macOS cache
    location, which the OS may auto-clean under disk pressure. Anything in
    here can be deleted with no data loss; it'll be recomputed on next use.
    """
    raw = os.getenv(_CACHE_ENV_VAR, "").strip()
    base = Path(raw).expanduser() if raw else _DEFAULT_CACHE_DIR
    base.mkdir(parents=True, exist_ok=True)
    return base.resolve()


def thumbnail_cache_path(source: Path, count: int, height: int) -> tuple[Path, Path]:
    """Where to cache the thumbnail sprite (and its metadata JSON) for a
    given source + dimensions. Returns (png_path, json_path).

    Keyed by sha256 of the absolute source path so distinct files with the
    same basename don't collide — root cause of the ghost-artifact bug that
    motivated this cache migration.
    """
    import hashlib

    abs_src = str(Path(source).expanduser().resolve())
    digest = hashlib.sha256(abs_src.encode()).hexdigest()[:16]
    key = f"{digest}.{count}x{height}"
    thumbs_dir = cache_dir() / "thumbs"
    thumbs_dir.mkdir(parents=True, exist_ok=True)
    return thumbs_dir / f"{key}.png", thumbs_dir / f"{key}.json"


def project_dir(source: Path) -> Path:
    """Legacy per-source dir keyed by ``source.stem``. Used as a fallback
    for sources outside any workspace project and as the home for the
    rendered MP4 output today (the AI render path hasn't been migrated to
    the project layout yet — that's step 3).
    """
    out = output_dir() / source.stem
    out.mkdir(parents=True, exist_ok=True)
    return out


def artifacts_dir(source: Path) -> Path:
    """Where intermediate pipeline artifacts (analysis JSON, mic WAV, etc.)
    live for the given source.

    - **Source inside a project**: ``<project>/artifacts/``. Scoping
      artifacts to the project avoids the cross-project stem-collision
      bug where deleting a project leaves stale artifacts in the global
      cache that get re-matched against unrelated files with the same
      filename.
    - **Source outside any project**: legacy ``<output_dir>/<stem>/``.
    """
    # Import locally to keep the projects ↔ paths dependency one-way:
    # projects.py knows nothing about paths.py, and paths.py only depends
    # on projects.py for the workspace root location.
    from .projects import projects_root

    try:
        abs_src = Path(source).expanduser().resolve()
    except OSError:
        return project_dir(source)

    try:
        proj_root = projects_root()
    except Exception:
        return project_dir(source)

    try:
        rel = abs_src.relative_to(proj_root)
    except ValueError:
        return project_dir(source)

    # First path component under projects_root is the project slug.
    if not rel.parts:
        return project_dir(source)
    out = proj_root / rel.parts[0] / "artifacts"
    out.mkdir(parents=True, exist_ok=True)
    return out


# ─── Per-stage path helpers ──────────────────────────────────────────────────


def analysis_path(source: Path) -> Path:
    return artifacts_dir(source) / f"{source.stem}.analysis.json"


def classified_path(source: Path) -> Path:
    return artifacts_dir(source) / f"{source.stem}.classified.json"


def plan_path(source: Path) -> Path:
    return artifacts_dir(source) / f"{source.stem}.plan.json"


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
    return artifacts_dir(source) / f"{source.stem}.mic.16k.wav"


def events_path(source: Path) -> Path:
    """Where the opt-in audio-event detection output (sniffles/throat
    clears/etc) is cached for a given source."""
    return artifacts_dir(source) / f"{source.stem}.events.json"


# ─── Backward-compat: legacy flat-layout lookups ─────────────────────────────


def legacy_flat_path(source: Path, suffix: str) -> Path:
    """The path an artifact *would* have been at under the pre-2026-05-21
    flat layout. Used by the probe response to keep old projects discoverable
    without forcing a migration."""
    return output_dir() / f"{source.stem}{suffix}"
