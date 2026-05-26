"""Shared fixtures for the test suite.

Tests deliberately avoid:
- Mocking LLM calls (the cadence/classifier modules are integration code;
  pure mocks add maintenance with little signal)
- End-to-end rendering (needs ffmpeg + real video; covered by manual smoke
  tests in the desktop app)
- Frontend coverage (UI tests are deferred until the React layout stabilizes)

What we DO test:
- Pure-function logic: planner interval algebra, override application,
  filename helpers, slug derivation
- Filesystem-backed pieces (projects manifest) with a temp projects root
  so the user's real ~/Cadence Lab Projects/ never gets touched
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from cadence_lab.models import (
    Classification,
    ClassificationBundle,
    ClassifiedFiller,
    ClassifiedPause,
    FillerCandidate,
    PauseCandidate,
    Retake,
    SpeechAnalysis,
)


@pytest.fixture
def speech_30s() -> SpeechAnalysis:
    """A 30-second SpeechAnalysis stub with no real transcript or VAD data.
    Sufficient for planner tests that only care about duration_seconds."""
    return SpeechAnalysis(
        audio_path=Path("/tmp/fake.wav"),
        duration_seconds=30.0,
        language="en",
        language_probability=1.0,
        vad_segments=[],
        segments=[],
    )


@pytest.fixture
def classification_bundle_basic() -> ClassificationBundle:
    """A bundle with two pauses and one filler, each classified.

    Layout (source time, seconds):
      [0, 5]    speech
      [5, 5.6]  pause #0 — classified "cut"   (filler-y silence)
      [5.6, 10] speech
      [10, 10.3] pause #1 — classified "trim" → 150ms breath
      [10.3, 20] speech with "um" filler #0 at [12.0, 12.3], cut
      [20, 30]  speech
    """
    return ClassificationBundle(
        pause_candidates=[
            PauseCandidate(id=0, start=5.0, end=5.6),
            PauseCandidate(id=1, start=10.0, end=10.3),
        ],
        filler_candidates=[
            FillerCandidate(
                id=0, word_index=42, text="um", start=12.0, end=12.3
            ),
        ],
        classification=Classification(
            pauses=[
                ClassifiedPause(
                    id=0, category="filler", action="cut", reason="dead air"
                ),
                ClassifiedPause(
                    id=1,
                    category="breath",
                    action="trim",
                    trim_to_ms=150,
                    reason="breath",
                ),
            ],
            fillers=[
                ClassifiedFiller(id=0, action="cut", reason="filler"),
            ],
            retakes=[],
        ),
        model_used="test-fixture",
    )


@pytest.fixture
def classification_with_retake() -> ClassificationBundle:
    """Bundle exercising the retake path — used for apply_overrides tests."""
    return ClassificationBundle(
        pause_candidates=[],
        filler_candidates=[],
        classification=Classification(
            pauses=[],
            fillers=[],
            retakes=[
                Retake(
                    cut_start=2.0,
                    cut_end=5.0,
                    keep_start=5.0,
                    keep_end=8.0,
                    reason="first attempt fumbled",
                ),
            ],
        ),
        model_used="test-fixture",
    )


@pytest.fixture
def isolated_projects_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point CADENCE_PROJECTS_ROOT at a fresh temp dir so project tests
    can't touch the user's real workspace at ~/Cadence Lab Projects."""
    root = tmp_path / "projects"
    monkeypatch.setenv("CADENCE_PROJECTS_ROOT", str(root))
    return root


@pytest.fixture
def isolated_output_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Same idea for the legacy `files/` output dir used by `paths` helpers
    when a source isn't inside a project."""
    out = tmp_path / "files"
    monkeypatch.setenv("CADENCE_OUTPUT_DIR", str(out))
    return out
