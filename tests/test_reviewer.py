"""Tests for apply_overrides — the review UI's main mutation point.

These exercise the full override key shape (kind, id), not just happy paths,
because the frontend sends a string-keyed dict that gets parsed into tuples
and any drift between sides shows up here first.
"""

from __future__ import annotations

from cadence_lab.models import (
    Classification,
    ClassifiedFiller,
    ClassifiedPause,
    Retake,
)
from cadence_lab.reviewer import apply_overrides


def _make_classification() -> Classification:
    return Classification(
        pauses=[
            ClassifiedPause(id=0, category="filler", action="keep", reason="r0"),
            ClassifiedPause(id=1, category="breath", action="trim", trim_to_ms=150, reason="r1"),
        ],
        fillers=[
            ClassifiedFiller(id=0, action="keep", reason="meaningful"),
            ClassifiedFiller(id=1, action="cut", reason="um"),
        ],
        retakes=[
            Retake(cut_start=1.0, cut_end=2.0, keep_start=2.0, keep_end=3.0, reason="r"),
        ],
    )


def test_apply_overrides_no_op_returns_equivalent():
    cls = _make_classification()
    out = apply_overrides(cls, {})
    assert out.model_dump() == cls.model_dump()


def test_apply_overrides_pause_action_changes():
    cls = _make_classification()
    out = apply_overrides(cls, {("pause", 0): "cut"})
    assert out.pauses[0].action == "cut"
    # Original untouched
    assert cls.pauses[0].action == "keep"


def test_apply_overrides_clearing_trim_wipes_trim_to_ms():
    """When a pause was 'trim' with trim_to_ms set and the user changes it
    to 'cut' or 'keep', the stale trim_to_ms must be cleared — otherwise
    downstream code reads a millisecond hint that no longer applies."""
    cls = _make_classification()
    out = apply_overrides(cls, {("pause", 1): "cut"})
    assert out.pauses[1].action == "cut"
    assert out.pauses[1].trim_to_ms is None


def test_apply_overrides_filler_action_changes():
    cls = _make_classification()
    out = apply_overrides(cls, {("filler", 0): "cut", ("filler", 1): "keep"})
    assert out.fillers[0].action == "cut"
    assert out.fillers[1].action == "keep"


def test_apply_overrides_retake_reject_drops_entry():
    cls = _make_classification()
    out = apply_overrides(cls, {("retake", 0): "reject"})
    assert out.retakes == []


def test_apply_overrides_retake_non_reject_keeps_entry():
    cls = _make_classification()
    out = apply_overrides(cls, {("retake", 0): "accept"})
    assert len(out.retakes) == 1


def test_apply_overrides_invalid_action_silently_ignored():
    """Defensive: a bogus override shouldn't crash — the UI is supposed to
    only produce valid values, but a malformed dict shouldn't break render."""
    cls = _make_classification()
    out = apply_overrides(cls, {("pause", 0): "explode"})
    assert out.pauses[0].action == "keep"  # unchanged


def test_apply_overrides_unknown_id_is_noop():
    cls = _make_classification()
    out = apply_overrides(cls, {("pause", 999): "cut"})
    assert out.model_dump() == cls.model_dump()
