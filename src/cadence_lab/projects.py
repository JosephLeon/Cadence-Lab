"""Project (workspace) model + filesystem layout.

A project is the unit of user work — one YouTube video, one tutorial, etc.
Everything related to that work lives in a single self-contained directory:

    <projects_root>/<slug>/
        project.json              # the manifest (single source of truth)
        sources/                  # original videos (copied or referenced)
        artifacts/                # AI pipeline outputs per source
        renders/                  # generated MP4s; never overwritten

The manifest is the *only* persisted state — in-memory stores in the
frontend rehydrate from it on load and write back on every mutation. Render
files on disk and the `render_history` entries in the manifest must be kept
in sync; the helpers in this module enforce that.

Legacy `files/<source-stem>/` projects from before this refactor are left
alone and continue to work via the existing pre-project code paths. Nothing
in this module touches them.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError


# ─── Filesystem location ─────────────────────────────────────────────────────

_DEFAULT_PROJECTS_ROOT = Path.home() / "Cadence Lab Projects"
_ENV_VAR = "CADENCE_PROJECTS_ROOT"


def projects_root() -> Path:
    """Where projects live on disk. Configurable via ``CADENCE_PROJECTS_ROOT``."""
    raw = os.getenv(_ENV_VAR, "").strip()
    root = Path(raw).expanduser() if raw else _DEFAULT_PROJECTS_ROOT
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


_SLUG_PATTERN = re.compile(r"[^a-z0-9]+")


def derive_slug(name: str) -> str:
    """Kebab-case a project name into a filesystem-safe slug.

    Empty slugs after sanitization fall back to ``"project"`` so we always
    have something to name the directory with.
    """
    s = _SLUG_PATTERN.sub("-", name.lower()).strip("-")
    return s or "project"


# ─── Manifest schema ─────────────────────────────────────────────────────────

# Bump when making a backwards-incompatible change to the manifest. Loaders
# should refuse anything they don't understand rather than silently misread.
SCHEMA_VERSION = 1


class SourceEntry(BaseModel):
    """One source video in the project.

    ``path`` is *relative to the project root* when ``ref_mode='copied'``
    (e.g. ``"sources/recording_01.mov"``) and *absolute* when
    ``ref_mode='external'``.
    """
    path: str
    ref_mode: Literal["copied", "external"]
    original_path: str | None = None
    added_at: str  # ISO-8601 UTC


class AudioSettings(BaseModel):
    enhance_speech: Literal["off", "low", "medium", "high"] = "off"
    auto_duck: bool = False
    ducking_db: int = -8


class AIState(BaseModel):
    """Per-source AI-tab state — sticky audio settings + review overrides."""
    audio: AudioSettings = Field(default_factory=AudioSettings)
    overrides: dict[str, str] = Field(default_factory=dict)


class SpliceClipEntry(BaseModel):
    """One clip on the splice timeline. Mirrors the frontend SpliceClip."""
    kind: Literal["video", "blank"]
    source_path: str | None = None
    source_start: float = 0.0
    source_end: float = 0.0
    duration: float = 0.0


class SpliceState(BaseModel):
    timeline: list[SpliceClipEntry] = Field(default_factory=list)
    last_space_seconds: float = 5.0


class RenderHistoryEntry(BaseModel):
    """One entry in the project's render history.

    ``input_render_id`` lets renders form a chain: a "pace" render of an
    "enhance" render points at the latter, so the UI (and Ask Cadence) can
    answer "where did this file come from?".
    """
    id: str                          # e.g. "r001"
    type: Literal["ai_render", "splice_render"]
    source: str | None = None        # project-relative source path
    input_render_id: str | None = None
    settings: dict[str, Any] = Field(default_factory=dict)
    output: str                      # relative path under renders/
    label: str                       # short human-readable description
    timestamp: str                   # ISO-8601 UTC
    size_bytes: int | None = None


class Project(BaseModel):
    """The manifest. Persisted as ``project.json`` at the project root."""
    schema_version: int = SCHEMA_VERSION
    slug: str                       # directory name; immutable
    name: str                       # human-readable; user can rename
    created_at: str
    modified_at: str
    sources: list[SourceEntry] = Field(default_factory=list)
    ai_state: dict[str, AIState] = Field(default_factory=dict)
    splice_state: SpliceState = Field(default_factory=SpliceState)
    render_history: list[RenderHistoryEntry] = Field(default_factory=list)
    # Computed on load — absolute filesystem path of this project's dir.
    # Not persisted to project.json (we recompute it from the slug every
    # time so the manifest stays portable if the projects root moves).
    path: str = ""


# ─── Errors ──────────────────────────────────────────────────────────────────


class ProjectError(RuntimeError):
    pass


class ProjectNotFound(ProjectError):
    pass


class ProjectExists(ProjectError):
    pass


# ─── Internal helpers ────────────────────────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _project_dir(slug: str) -> Path:
    return projects_root() / slug


def _manifest_path(project_dir: Path) -> Path:
    return project_dir / "project.json"


def _ensure_subdirs(project_dir: Path) -> None:
    for sub in ("sources", "artifacts", "renders"):
        (project_dir / sub).mkdir(parents=True, exist_ok=True)


def _atomic_write_text(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` atomically — write to a sibling tempfile
    then rename. Prevents partial-write corruption on crash."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w",
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
        encoding="utf-8",
    ) as f:
        f.write(text)
        tmp = Path(f.name)
    tmp.replace(path)


# ─── Public API ──────────────────────────────────────────────────────────────


def create_project(name: str) -> Project:
    """Create a fresh project directory + manifest.

    The slug is derived from ``name``. If a project with that slug already
    exists we suffix with a timestamp to avoid clobbering; the *name* (what
    the user sees in the UI) stays as they typed it.
    """
    if not name.strip():
        raise ProjectError("project name is empty")

    base_slug = derive_slug(name)
    slug = base_slug
    if _project_dir(slug).exists():
        slug = f"{base_slug}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        if _project_dir(slug).exists():
            raise ProjectExists(f"project already exists: {slug}")

    pdir = _project_dir(slug)
    pdir.mkdir(parents=True)
    _ensure_subdirs(pdir)

    now = _now_iso()
    project = Project(
        slug=slug,
        name=name.strip(),
        created_at=now,
        modified_at=now,
    )
    save_project(project)
    project.path = str(pdir.resolve())
    return project


def load_project(slug: str) -> Project:
    """Read a project's manifest from disk. Raises ``ProjectNotFound`` if
    the project directory or manifest is missing; raises ``ProjectError`` if
    the manifest exists but can't be parsed (refuse to silently lose data)."""
    pdir = _project_dir(slug)
    mpath = _manifest_path(pdir)
    if not mpath.exists():
        raise ProjectNotFound(f"no manifest at {mpath}")
    try:
        data = json.loads(mpath.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ProjectError(f"manifest is not valid JSON: {e}") from e
    try:
        project = Project(**data)
    except ValidationError as e:
        raise ProjectError(f"manifest failed schema validation: {e}") from e
    if project.schema_version != SCHEMA_VERSION:
        raise ProjectError(
            f"manifest schema_version={project.schema_version}, "
            f"this build expects {SCHEMA_VERSION}"
        )
    _ensure_subdirs(pdir)
    project.path = str(pdir.resolve())
    return project


def save_project(project: Project) -> None:
    """Persist a project's manifest atomically, updating ``modified_at``.

    The ``path`` field is excluded from the on-disk JSON — it's derived
    from the project's directory at load time, so persisting it would just
    drift if the projects root ever moved.
    """
    project.modified_at = _now_iso()
    pdir = _project_dir(project.slug)
    pdir.mkdir(parents=True, exist_ok=True)
    text = project.model_dump_json(indent=2, exclude={"path"})
    _atomic_write_text(_manifest_path(pdir), text)


def delete_project(slug: str) -> None:
    """Permanently delete a project directory + everything in it.

    Irreversible. Frontend should confirm before calling. Raises
    ``ProjectNotFound`` if the project doesn't exist; raises
    ``ProjectError`` if the directory is somehow outside the projects
    root (shouldn't happen, but defensive: we never want a slug-injection
    bug to ``rm -rf`` somewhere unexpected).
    """
    pdir = _project_dir(slug)
    root = projects_root()
    try:
        pdir.resolve().relative_to(root)
    except ValueError as e:
        raise ProjectError(f"refusing to delete outside projects root: {pdir}") from e
    if not pdir.exists():
        raise ProjectNotFound(f"no project at {pdir}")
    shutil.rmtree(pdir)


def list_projects() -> list[dict[str, Any]]:
    """Return a lightweight summary of every project on disk, sorted by
    most recently modified first. Doesn't validate manifests — used by the
    "Open recent" picker, which should still show projects that may need
    repair (the load attempt will surface the error)."""
    out: list[dict[str, Any]] = []
    root = projects_root()
    if not root.exists():
        return out
    for child in root.iterdir():
        if not child.is_dir():
            continue
        mpath = _manifest_path(child)
        if not mpath.exists():
            continue
        try:
            data = json.loads(mpath.read_text(encoding="utf-8"))
            out.append(
                {
                    "slug": data.get("slug", child.name),
                    "name": data.get("name", child.name),
                    "created_at": data.get("created_at"),
                    "modified_at": data.get("modified_at"),
                    "source_count": len(data.get("sources", [])),
                    "render_count": len(data.get("render_history", [])),
                    "path": str(child),
                }
            )
        except (json.JSONDecodeError, OSError):
            # Surface broken projects so the UI can show "needs repair"
            # without crashing the list.
            out.append(
                {
                    "slug": child.name,
                    "name": child.name,
                    "broken": True,
                    "path": str(child),
                }
            )
    out.sort(key=lambda p: p.get("modified_at") or "", reverse=True)
    return out


# ─── Source management ──────────────────────────────────────────────────────


def add_source(
    project: Project,
    src_path: Path,
    *,
    mode: Literal["copy", "reference"] = "copy",
) -> SourceEntry:
    """Add a source video to the project.

    - ``mode="copy"``: duplicate into ``<project>/sources/`` (default).
      Project becomes portable but uses disk equal to the source size.
    - ``mode="reference"``: store the absolute path. Project stays tiny but
      breaks if the source is later moved/renamed in Finder.

    The caller is responsible for ``save_project()`` after this returns —
    we don't auto-save so callers can batch multiple changes.
    """
    src = Path(src_path).expanduser().resolve()
    if not src.exists():
        raise ProjectError(f"source does not exist: {src}")

    pdir = _project_dir(project.slug)
    _ensure_subdirs(pdir)

    if mode == "copy":
        dest = pdir / "sources" / src.name
        # If a file with that name already exists, suffix until unique.
        i = 1
        while dest.exists():
            stem, suf = src.stem, src.suffix
            dest = pdir / "sources" / f"{stem}__{i}{suf}"
            i += 1
        shutil.copy2(src, dest)
        rel = dest.relative_to(pdir).as_posix()
        entry = SourceEntry(
            path=rel,
            ref_mode="copied",
            original_path=str(src),
            added_at=_now_iso(),
        )
    else:
        entry = SourceEntry(
            path=str(src),
            ref_mode="external",
            original_path=None,
            added_at=_now_iso(),
        )

    project.sources.append(entry)
    return entry


def resolve_source(project: Project, entry: SourceEntry) -> Path:
    """Return the absolute path to a source file, honoring ``ref_mode``."""
    if entry.ref_mode == "copied":
        return (_project_dir(project.slug) / entry.path).resolve()
    return Path(entry.path).expanduser().resolve()


# ─── Render IDs ─────────────────────────────────────────────────────────────


_RENDER_ID_PATTERN = re.compile(r"^r(\d+)$")


def next_render_id(project: Project) -> str:
    """Monotonic render ID across the project. Always at least 3 digits so
    they sort lexicographically up to r999, after which they grow naturally."""
    highest = 0
    for r in project.render_history:
        m = _RENDER_ID_PATTERN.match(r.id)
        if m:
            highest = max(highest, int(m.group(1)))
    return f"r{highest + 1:03d}"


def project_dir_path(slug: str) -> Path:
    """Public accessor — the absolute project directory for a slug.

    Useful for callers that need to compute output paths (renders/, etc.)
    relative to the project root.
    """
    return _project_dir(slug).resolve()
