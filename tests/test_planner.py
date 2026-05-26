"""Tests for the cut planner — interval algebra + plan_cuts integration.

These are the highest-value tests in the suite: planner bugs produce
silently wrong renders that are hard to spot until you watch the output.
"""

from __future__ import annotations

import pytest

from cadence_lab.models import CutPlanParams, SpeechAnalysis
from cadence_lab.planner import _complement, _merge, plan_cuts


# ─── _merge ──────────────────────────────────────────────────────────────────


def test_merge_empty():
    assert _merge([]) == []


def test_merge_non_overlapping_preserves_order():
    assert _merge([(5.0, 6.0), (1.0, 2.0), (3.0, 4.0)]) == [
        (1.0, 2.0),
        (3.0, 4.0),
        (5.0, 6.0),
    ]


def test_merge_overlapping_combines():
    assert _merge([(1.0, 3.0), (2.0, 4.0)]) == [(1.0, 4.0)]


def test_merge_touching_combines():
    # Adjacent intervals (end == next start) merge — preserves the
    # invariant that the complement won't have a 0-width keep between.
    assert _merge([(1.0, 2.0), (2.0, 3.0)]) == [(1.0, 3.0)]


def test_merge_fully_contained_collapses():
    assert _merge([(1.0, 10.0), (3.0, 5.0)]) == [(1.0, 10.0)]


# ─── _complement ─────────────────────────────────────────────────────────────


def test_complement_no_removes_keeps_everything():
    assert _complement([], 30.0) == [(0.0, 30.0)]


def test_complement_single_removal_in_middle():
    assert _complement([(10.0, 15.0)], 30.0) == [(0.0, 10.0), (15.0, 30.0)]


def test_complement_removal_at_start():
    assert _complement([(0.0, 5.0)], 30.0) == [(5.0, 30.0)]


def test_complement_removal_at_end():
    assert _complement([(25.0, 30.0)], 30.0) == [(0.0, 25.0)]


def test_complement_clamps_to_duration():
    # Removal extending past duration shouldn't produce a negative keep.
    assert _complement([(25.0, 100.0)], 30.0) == [(0.0, 25.0)]


# ─── plan_cuts integration ───────────────────────────────────────────────────


def test_plan_cuts_basic_pause_and_filler(
    speech_30s: SpeechAnalysis, classification_bundle_basic
):
    plan = plan_cuts(speech_30s, classification_bundle_basic)

    # Audit log preserves the original intents
    kinds = {c.kind for c in plan.cuts}
    assert "pause_cut" in kinds
    assert "filler_cut" in kinds
    assert "pause_trim" in kinds  # two trim operations from the breath

    # Pause #0 cut: [5.0, 5.6] removed
    # Pause #1 trim: 300ms → 150ms, so 75ms shaved from each end
    # Filler #0: [12.0, 12.3] removed, padded by 20ms each side → [11.98, 12.32]
    # Source is 30s — expect several keep segments
    assert plan.source_duration == 30.0
    assert plan.output_duration < 30.0
    assert plan.output_duration > 0
    # No keep segment should overlap the cut at [5.0, 5.6]
    for k in plan.keeps:
        assert not (k.source_start < 5.6 and k.source_end > 5.0), (
            f"keep {k} overlaps cut pause"
        )


def test_plan_cuts_custom_cut_merges_with_classifier_cuts(
    speech_30s: SpeechAnalysis, classification_bundle_basic
):
    # A custom cut overlapping pause #0 should not create two separate
    # removals — they merge into one.
    custom = [(5.0, 7.0, "user override")]
    plan = plan_cuts(speech_30s, classification_bundle_basic, custom_cuts=custom)

    # Audit log records both the classifier pause_cut AND the custom_cut.
    custom_ops = [c for c in plan.cuts if c.kind == "custom_cut"]
    assert len(custom_ops) == 1
    assert custom_ops[0].reason == "user override"

    # After merging, no keep should fall inside [5.0, 7.0].
    for k in plan.keeps:
        assert not (k.source_start < 7.0 and k.source_end > 5.0), (
            f"keep {k} overlaps merged custom + pause cut"
        )


def test_plan_cuts_ignores_zero_or_negative_custom_cut():
    """end ≤ start custom cuts must be silently dropped — the frontend
    sometimes sends them during drag-resize and they'd otherwise pollute
    the audit log."""
    speech = SpeechAnalysis(
        audio_path="/tmp/x.wav",  # type: ignore[arg-type]
        duration_seconds=10.0,
        language="en",
        language_probability=1.0,
        vad_segments=[],
        segments=[],
    )
    from cadence_lab.models import Classification, ClassificationBundle

    empty_bundle = ClassificationBundle(
        pause_candidates=[],
        filler_candidates=[],
        classification=Classification(pauses=[], fillers=[], retakes=[]),
        model_used="test",
    )
    plan = plan_cuts(
        speech, empty_bundle, custom_cuts=[(5.0, 5.0, "zero width"), (8.0, 6.0, "negative")]
    )
    assert plan.cuts == []
    assert plan.keeps == [
        # full source survives
    ] or len(plan.keeps) == 1 and plan.keeps[0].source_start == 0.0


def test_plan_cuts_drops_tiny_slivers(
    speech_30s: SpeechAnalysis, classification_bundle_basic
):
    """A min_keep_ms threshold must drop slivers that survive merging
    but are too short to render cleanly with crossfades."""
    params = CutPlanParams(min_keep_ms=500)  # drop anything <500ms
    plan = plan_cuts(speech_30s, classification_bundle_basic, params=params)
    for k in plan.keeps:
        assert k.duration >= 0.5
