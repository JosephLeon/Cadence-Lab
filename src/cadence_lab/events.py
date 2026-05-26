"""Audio-event detection (sniffles, throat clears, coughs, lip smacks).

This is a separate pass from `analyze` because it's slow (~real-time-ish
on CPU for 16k mono) and most users don't need it. The frontend exposes
it as an opt-in pipeline stage and Cadence can trigger it on demand when
the user asks about non-speech sounds.

Implementation: PANNs CNN14 SoundEventDetection model from
``panns_inference``. Runs frame-level inference (~10ms hop on 16kHz
audio), thresholds per-class confidence, then merges consecutive
above-threshold frames into discrete events.

First-run note: ``panns_inference`` auto-downloads its model checkpoint
but does *not* always download the AudioSet class-labels CSV it needs
to construct ``SoundEventDetection``. We explicitly fetch that CSV
before instantiating the model — without it the constructor throws
``FileNotFoundError: ~/panns_data/class_labels_indices.csv``.
"""

from __future__ import annotations

import csv
import threading
import urllib.request
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from .models import AudioEvent

ProgressFn = Callable[[float, str], None]


# Sample rate the model expects.
_TARGET_SR = 32000

# Per-class confidence threshold for "event present" in a single frame.
# Tuned conservatively to favor precision (avoid false-positive cuts)
# over recall — the worst outcome for the user is an unwanted cut, not
# a missed sniffle.
_FRAME_THRESHOLD = 0.35

# Min duration to count as an event (frames shorter than this are
# usually classifier noise on transients in speech).
_MIN_EVENT_MS = 80

# Bridge gaps shorter than this between same-class frames into a single
# event so a stuttering "throat clear" doesn't come out as 5 micro-events.
_BRIDGE_GAP_MS = 120


# Map AudioSet display names → our compact friendly slug. Multiple
# display names can collapse onto the same slug (e.g. "Cough" and
# "Coughing" both → "cough"). At runtime we resolve display names to
# numeric class IDs via the downloaded class_labels_indices.csv, so we
# don't depend on hardcoded indices that vary across model versions.
_NAME_TO_KIND: dict[str, str] = {
    "throat clearing": "throat_clear",
    "cough": "cough",
    "coughing": "cough",
    "sneeze": "sneeze",
    "sniff": "sniff",
    "sniffing": "sniff",
    "hiccup": "hiccup",
    "burping, eructation": "burp",
    # AudioSet doesn't have a dedicated "lip smack" class; "Slap, smack"
    # (467) is too broad (any percussive smack) so we skip it rather
    # than flood the user with false positives.
}


_PANNS_DATA_DIR = Path.home() / "panns_data"
_LABELS_CSV = _PANNS_DATA_DIR / "class_labels_indices.csv"
_LABELS_URL = (
    "https://raw.githubusercontent.com/qiuqiangkong/audioset_tagging_cnn"
    "/master/metadata/class_labels_indices.csv"
)
_CHECKPOINT = _PANNS_DATA_DIR / "Cnn14_DecisionLevelMax.pth"
# Zenodo URL for the SED checkpoint trained on AudioSet (mAP=0.385).
# panns_inference expects the local filename without the mAP suffix, so
# we rename on save.
_CHECKPOINT_URL = (
    "https://zenodo.org/record/3987831/files/"
    "Cnn14_DecisionLevelMax_mAP%3D0.385.pth"
)
_CHECKPOINT_MIN_BYTES = 50_000_000  # actual is ~320MB; guards against partials


def _ensure_class_labels_csv() -> Path:
    """``panns_inference``'s SoundEventDetection constructor reads class
    labels from ``~/panns_data/class_labels_indices.csv`` but doesn't
    auto-fetch the file. Download it explicitly if missing — small
    (~50KB) and only happens once."""
    if _LABELS_CSV.exists() and _LABELS_CSV.stat().st_size > 0:
        return _LABELS_CSV
    _PANNS_DATA_DIR.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(_LABELS_URL, _LABELS_CSV)
    return _LABELS_CSV


def _ensure_checkpoint(progress: ProgressFn | None = None) -> Path:
    """``panns_inference`` *also* doesn't auto-download the model weights,
    despite advertising that it does. The constructor just tries to
    ``torch.load`` from the expected path and throws ``FileNotFoundError``
    if missing. Fetch the canonical checkpoint from Zenodo (~320MB) and
    place it at the path the library wants."""
    if _CHECKPOINT.exists() and _CHECKPOINT.stat().st_size >= _CHECKPOINT_MIN_BYTES:
        return _CHECKPOINT
    _PANNS_DATA_DIR.mkdir(parents=True, exist_ok=True)
    # Download to a temp path then atomic-rename so a half-finished
    # download (network drop) doesn't leave a corrupt file at the real
    # path that we'll later think is valid.
    tmp = _CHECKPOINT.with_suffix(".pth.partial")

    def _report(blocks: int, block_size: int, total_size: int) -> None:
        if progress is None or total_size <= 0:
            return
        downloaded = min(blocks * block_size, total_size)
        # Map the download span into the 0.10–0.40 progress slice — leaves
        # room for the actual inference work afterwards.
        frac = 0.10 + 0.30 * (downloaded / total_size)
        mb = downloaded / 1_048_576
        total_mb = total_size / 1_048_576
        progress(frac, f"Downloading detection model… {mb:.0f}/{total_mb:.0f} MB")

    urllib.request.urlretrieve(_CHECKPOINT_URL, tmp, reporthook=_report)
    tmp.replace(_CHECKPOINT)
    return _CHECKPOINT


# (class_id, friendly_name) pairs resolved once on first scan.
_TRACKED_IDS: list[tuple[int, str]] | None = None


def _resolve_tracked_ids() -> list[tuple[int, str]]:
    """Return (audioset_class_id, friendly_kind) pairs for the events
    we care about. Cached after first resolution."""
    global _TRACKED_IDS
    if _TRACKED_IDS is not None:
        return _TRACKED_IDS
    csv_path = _ensure_class_labels_csv()
    pairs: list[tuple[int, str]] = []
    with open(csv_path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = (row.get("display_name") or "").strip().lower()
            kind = _NAME_TO_KIND.get(name)
            if kind is None:
                continue
            try:
                idx = int(row["index"])
            except (ValueError, KeyError):
                continue
            pairs.append((idx, kind))
    _TRACKED_IDS = pairs
    return pairs


# Heavy module: cached singleton so consecutive scans don't reload.
_MODEL_LOCK = threading.Lock()
_MODEL = None


def _load_model(progress: ProgressFn | None = None):
    """Lazy-load the PANNs SED model. Cached process-wide. Downloads the
    labels CSV + ~320MB checkpoint on first run (panns_inference doesn't
    do this itself)."""
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL
        _ensure_class_labels_csv()
        _ensure_checkpoint(progress)
        from panns_inference import SoundEventDetection  # type: ignore

        if progress:
            progress(0.45, "Loading detection model into memory…")
        # CPU device is fine; PANNs on Apple Silicon CPU runs at ~1x
        # realtime, which is acceptable for an opt-in pass.
        _MODEL = SoundEventDetection(checkpoint_path=None, device="cpu")
    return _MODEL


def detect_events(
    audio_path: Path,
    *,
    progress: ProgressFn | None = None,
) -> list[AudioEvent]:
    """Detect non-speech audio events in ``audio_path``.

    Returns events sorted by start time. Only events matching classes in
    :data:`TRACKED_CLASSES` are returned — we don't want to flood the UI
    with "speech," "music," etc. since those overlap with the user's
    actual content.
    """
    audio_path = Path(audio_path)
    if not audio_path.exists():
        raise FileNotFoundError(audio_path)

    if progress:
        progress(0.02, "Loading audio…")
    waveform, sr = sf.read(str(audio_path), dtype="float32", always_2d=False)
    if waveform.ndim > 1:
        waveform = waveform.mean(axis=1)
    if sr != _TARGET_SR:
        if progress:
            progress(0.05, f"Resampling {sr}Hz → {_TARGET_SR}Hz…")
        # Use scipy (already a transitive dep through PANNs) to resample.
        from scipy.signal import resample_poly

        from math import gcd

        g = gcd(int(sr), _TARGET_SR)
        waveform = resample_poly(waveform, _TARGET_SR // g, int(sr) // g).astype(
            "float32"
        )
        sr = _TARGET_SR

    if progress:
        progress(
            0.10,
            "Loading detection model (first run downloads ~320MB)…",
        )
    model = _load_model(progress=progress)

    if progress:
        progress(0.20, "Running event detection…")
    # PANNs expects shape (batch=1, time). Returns framewise_output shape
    # (batch, time_steps, num_classes) with sigmoid probabilities.
    waveform_b = waveform[np.newaxis, :]
    framewise_output = model.inference(waveform_b)
    # `inference` returns a dict in some versions; normalize.
    if isinstance(framewise_output, dict):
        framewise_output = framewise_output.get(
            "framewise_output", framewise_output.get("output")
        )
    framewise_output = np.asarray(framewise_output)
    if framewise_output.ndim == 3:
        framewise_output = framewise_output[0]  # drop batch

    if progress:
        progress(0.85, "Extracting events from per-frame predictions…")

    n_frames, _n_classes = framewise_output.shape
    duration = len(waveform) / float(sr)
    # PANNs hop is the model's internal frame rate; recover from duration.
    hop_seconds = duration / max(n_frames, 1)
    min_event_frames = max(1, int((_MIN_EVENT_MS / 1000.0) / hop_seconds))
    bridge_gap_frames = max(1, int((_BRIDGE_GAP_MS / 1000.0) / hop_seconds))

    events: list[AudioEvent] = []
    for cls_id, friendly in _resolve_tracked_ids():
        if cls_id >= framewise_output.shape[1]:
            continue
        col = framewise_output[:, cls_id]
        above = col >= _FRAME_THRESHOLD
        if not above.any():
            continue
        # Find runs of consecutive above-threshold frames, with gap-
        # bridging so stuttery events don't get split.
        events.extend(
            _extract_runs(
                col, above, friendly, hop_seconds, min_event_frames, bridge_gap_frames
            )
        )

    # Dedup events that overlap heavily across aliased classes (e.g. PANNs
    # tagging the same throat clear as both 36 and 38). Keep the higher
    # confidence one.
    events = _deduplicate_overlapping(events)
    events.sort(key=lambda e: e.start)

    if progress:
        progress(1.0, f"Found {len(events)} events.")
    return events


# ─── Helpers ────────────────────────────────────────────────────────────────


def _extract_runs(
    col: np.ndarray,
    above: np.ndarray,
    friendly: str,
    hop_s: float,
    min_frames: int,
    bridge_frames: int,
) -> list[AudioEvent]:
    """Pull (start, end, confidence) events out of a boolean mask, merging
    runs separated by short gaps."""
    out: list[AudioEvent] = []
    n = len(above)
    i = 0
    while i < n:
        if not above[i]:
            i += 1
            continue
        run_start = i
        # Walk forward, allowing short gaps.
        gap = 0
        last_active = i
        j = i + 1
        while j < n:
            if above[j]:
                last_active = j
                gap = 0
            else:
                gap += 1
                if gap > bridge_frames:
                    break
            j += 1
        run_end = last_active + 1
        if run_end - run_start >= min_frames:
            confidence = float(col[run_start:run_end].max())
            out.append(
                AudioEvent(
                    start=round(run_start * hop_s, 3),
                    end=round(run_end * hop_s, 3),
                    kind=friendly,
                    confidence=round(confidence, 3),
                )
            )
        i = run_end + 1
    return out


def _deduplicate_overlapping(events: list[AudioEvent]) -> list[AudioEvent]:
    """When two different classes flag overlapping ranges (common — PANNs
    is fuzzy on similar mouth sounds), keep the higher-confidence one.

    Doesn't merge across non-overlapping events even if they're the same
    class; that's already handled by the bridge-gap logic in
    :func:`_extract_runs`.
    """
    if not events:
        return events
    events_sorted = sorted(events, key=lambda e: (e.start, -e.confidence))
    kept: list[AudioEvent] = []
    for e in events_sorted:
        overlap = next(
            (
                k
                for k in kept
                if not (e.end <= k.start or e.start >= k.end)
            ),
            None,
        )
        if overlap is None:
            kept.append(e)
            continue
        if e.confidence > overlap.confidence:
            kept.remove(overlap)
            kept.append(e)
    return kept
