"""Stage 4 — cut planner.

Takes a stage-2 ``SpeechAnalysis`` and a stage-3 ``ClassificationBundle`` and
produces a ``CutPlan`` — the edit decision list the renderer (stage 5) will
execute. No video is touched here; this is pure interval algebra over the
source timeline.

## Algorithm

1. Each classifier output that says "cut" or "trim" contributes one or more
   intervals to a removal set, recorded individually for the audit log.
2. Removal intervals are merged (overlapping ranges collapse into one).
3. The complement of the merged removals in [0, source_duration] is the keep
   set — the contiguous ranges that survive into the final cut.
4. Keeps shorter than ``params.min_keep_ms`` are dropped (artifact of
   overlapping cuts; would be inaudible anyway after a crossfade).

## What this stage *doesn't* do (deferred)

- **Screen-change snapping.** The architecture calls for snapping cut points
  to nearby screen-change moments so cuts feel intentional. That requires the
  stage-4-prereq screen analysis (frame perceptual-hash diffs) which isn't
  built yet. When it lands, it becomes a post-pass that nudges each keep
  boundary by ±500 ms toward the closest screen change.
- **J/L cuts.** Out of scope per the locked architecture — screen-recording
  content doesn't benefit from them.
- **Audio crossfade application.** The plan *records* the crossfade
  parameter; the renderer is what actually crossfades.
"""

from __future__ import annotations

from .models import (
    Classification,
    ClassificationBundle,
    CutOperation,
    CutPlan,
    CutPlanParams,
    FillerCandidate,
    KeepSegment,
    PauseCandidate,
    SpeechAnalysis,
)

# Internal: (start, end, kind, reason) tuple flowing through the pipeline.
_Cut = tuple[float, float, str, str]


# ─── Building the removal set from classifier output ─────────────────────────


def _gather_cuts(
    classification: Classification,
    pause_by_id: dict[int, PauseCandidate],
    filler_by_id: dict[int, FillerCandidate],
    params: CutPlanParams,
) -> list[_Cut]:
    cuts: list[_Cut] = []
    filler_pad = params.filler_pad_ms / 1000.0

    for p in classification.pauses:
        cand = pause_by_id.get(p.id)
        if cand is None:
            continue
        if p.action == "cut":
            cuts.append((cand.start, cand.end, "pause_cut", p.reason))
        elif p.action == "trim":
            preserve_ms = p.trim_to_ms if p.trim_to_ms is not None else params.default_breath_ms
            preserve = max(preserve_ms, 0) / 1000.0
            if cand.duration > preserve:
                # Symmetric trim: shave equal time from each end so the
                # remaining beat lands centered in the original gap.
                pad = (cand.duration - preserve) / 2
                cuts.append((cand.start, cand.start + pad, "pause_trim", p.reason))
                cuts.append((cand.end - pad, cand.end, "pause_trim", p.reason))

    for f in classification.fillers:
        if f.action != "cut":
            continue
        cand = filler_by_id.get(f.id)
        if cand is None:
            continue
        # Pad both ends so we don't clip the surrounding words. Whisper word
        # timestamps have ~50ms jitter; 20ms of pad is a conservative buffer
        # and crossfades hide the rest.
        cuts.append((
            max(cand.start - filler_pad, 0.0),
            cand.end + filler_pad,
            "filler_cut",
            f.reason,
        ))

    for r in classification.retakes:
        cuts.append((r.cut_start, r.cut_end, "retake_cut", r.reason))

    # Normalize: keep only non-empty, in-range intervals.
    return [(s, e, k, why) for (s, e, k, why) in cuts if e > s]


# ─── Interval algebra ────────────────────────────────────────────────────────


def _merge(intervals: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Merge overlapping or touching [start, end] intervals."""
    if not intervals:
        return []
    sorted_iv = sorted(intervals, key=lambda x: x[0])
    merged: list[tuple[float, float]] = [sorted_iv[0]]
    for start, end in sorted_iv[1:]:
        m_start, m_end = merged[-1]
        if start <= m_end:
            merged[-1] = (m_start, max(m_end, end))
        else:
            merged.append((start, end))
    return merged


def _complement(
    removes: list[tuple[float, float]],
    duration: float,
) -> list[tuple[float, float]]:
    """Compute [0, duration] minus the removal intervals."""
    if not removes:
        return [(0.0, duration)]
    keeps: list[tuple[float, float]] = []
    cursor = 0.0
    for r_start, r_end in removes:
        r_start = max(r_start, 0.0)
        r_end = min(r_end, duration)
        if r_start > cursor:
            keeps.append((cursor, r_start))
        cursor = max(cursor, r_end)
        if cursor >= duration:
            break
    if cursor < duration:
        keeps.append((cursor, duration))
    return keeps


# ─── Top-level entry point ───────────────────────────────────────────────────


def plan_cuts(
    speech: SpeechAnalysis,
    classification_bundle: ClassificationBundle,
    params: CutPlanParams | None = None,
    custom_cuts: list[tuple[float, float, str]] | None = None,
) -> CutPlan:
    """Convert classification output (plus any user/AI-added arbitrary cuts)
    into a renderable CutPlan.

    ``custom_cuts`` are (start_seconds, end_seconds, reason) tuples that the
    user or Cadence added outside the classifier's pause/filler taxonomy.
    They go through the same merge → complement pipeline as classifier
    cuts, so overlaps are handled cleanly.
    """
    params = params or CutPlanParams()

    pause_by_id = {p.id: p for p in classification_bundle.pause_candidates}
    filler_by_id = {f.id: f for f in classification_bundle.filler_candidates}
    cuts_raw = _gather_cuts(
        classification_bundle.classification,
        pause_by_id,
        filler_by_id,
        params,
    )

    # Layer in user/Cadence-added arbitrary cuts on top of the classifier
    # ones. We tag them as `custom_cut` in the audit log so the UI can
    # distinguish them from pause/filler/retake cuts.
    if custom_cuts:
        for (s, e, why) in custom_cuts:
            if e > s:
                cuts_raw.append((s, e, "custom_cut", why or "user/Cadence cut"))

    # Audit log: original intents, before any merging.
    cut_ops = [
        CutOperation(source_start=s, source_end=e, kind=k, reason=why)  # type: ignore[arg-type]
        for (s, e, k, why) in cuts_raw
    ]

    # Build the merged remove set, take its complement, drop tiny keeps.
    removes = _merge([(s, e) for (s, e, _, _) in cuts_raw])
    keep_intervals = _complement(removes, speech.duration_seconds)
    min_keep_s = params.min_keep_ms / 1000.0
    keeps = [
        KeepSegment(source_start=s, source_end=e)
        for (s, e) in keep_intervals
        if e - s >= min_keep_s
    ]
    output_duration = sum(k.duration for k in keeps)

    return CutPlan(
        source_duration=speech.duration_seconds,
        output_duration=output_duration,
        keeps=keeps,
        cuts=cut_ops,
        params=params,
    )
