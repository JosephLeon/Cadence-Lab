"""Tests for the project manifest — slug derivation + create/load/save roundtrip.

These run against an isolated CADENCE_PROJECTS_ROOT so the user's real
~/Cadence Lab Projects/ never gets touched.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from cadence_lab.projects import (
    ProjectNotFound,
    create_project,
    derive_slug,
    load_project,
    save_project,
)


# ─── derive_slug ─────────────────────────────────────────────────────────────


def test_derive_slug_basic():
    assert derive_slug("My Channel") == "my-channel"


def test_derive_slug_collapses_repeated_non_alphanumeric():
    assert derive_slug("Hello!!!  World") == "hello-world"


def test_derive_slug_strips_leading_trailing_separators():
    assert derive_slug("  -- weird name -- ") == "weird-name"


def test_derive_slug_handles_unicode_by_dropping():
    # Non-ASCII letters aren't in the [a-z0-9] allow-list, so they get
    # treated as separators. Worth pinning so a rename to "Café" doesn't
    # silently produce a slug full of dashes.
    assert derive_slug("Café Latte") == "caf-latte"


def test_derive_slug_empty_falls_back():
    """Empty / all-special-char inputs must still produce a valid slug —
    otherwise we'd try to mkdir at the projects root itself."""
    assert derive_slug("") == "project"
    assert derive_slug("!!!") == "project"


# ─── create / load / save roundtrip ──────────────────────────────────────────


def test_create_project_writes_manifest_and_subdirs(isolated_projects_root: Path):
    project = create_project("Episode 12")
    project_dir = isolated_projects_root / project.slug
    assert project_dir.is_dir()
    assert (project_dir / "project.json").is_file()
    for sub in ("sources", "artifacts", "renders"):
        assert (project_dir / sub).is_dir(), f"missing subdir: {sub}"


def test_create_project_duplicate_name_gets_suffixed_slug(isolated_projects_root: Path):
    """Same display name twice = both projects survive, the second one
    gets a timestamp-suffixed slug. We don't want to lose the user's work
    just because they typed the same name twice."""
    first = create_project("My Project")
    second = create_project("My Project")
    assert first.slug == "my-project"
    assert second.slug != first.slug
    assert second.slug.startswith("my-project-")
    assert second.name == "My Project"  # display name is preserved


def test_load_project_returns_what_was_saved(isolated_projects_root: Path):
    project = create_project("Roundtrip")
    project.name = "Roundtrip Renamed"
    save_project(project)

    loaded = load_project(project.slug)
    assert loaded.name == "Roundtrip Renamed"
    assert loaded.slug == project.slug
    # path is computed from the projects root on load, not stored
    assert Path(loaded.path).is_dir()


def test_load_unknown_project_raises_not_found(isolated_projects_root: Path):
    with pytest.raises(ProjectNotFound):
        load_project("does-not-exist")


def test_slug_escape_attempts_are_rejected(isolated_projects_root: Path):
    """Defense against a malicious project share: a manifest carrying
    ``slug: "../../tmp/pwned"`` must not let the renderer write outside
    the projects root. ``_project_dir`` is the chokepoint and refuses
    any slug that resolves outside the configured root."""
    from cadence_lab.projects import ProjectError, _project_dir

    for bad in ("../escape", "../../tmp/pwned", "..", "foo/../../escape"):
        with pytest.raises(ProjectError):
            _project_dir(bad)


def test_save_project_is_atomic_no_tempfile_leak(isolated_projects_root: Path):
    """The atomic write pattern (tempfile + rename) must not leave .tmp
    files behind on success — they'd show up in the project dir listing."""
    project = create_project("Atomicity")
    for _ in range(5):
        save_project(project)
    project_dir = Path(project.path)
    leftover = list(project_dir.glob("*.tmp"))
    assert leftover == [], f"tempfile leak: {leftover}"
