"""Stage 6 — review utilities.

The review surface itself lives in the Streamlit UI; this module contains the
two pure functions the UI calls into:

- ``apply_overrides`` — given a ``Classification`` and a dict of user-edited
  decisions, return a *new* ``Classification`` with those decisions applied.
  Feeding the result back into ``plan_cuts`` is what makes "Apply changes"
  produce an updated ``CutPlan``.
- ``extract_audio_clip`` — pull a short MP3 from the source audio around a
  given time window, for inline playback. ffmpeg-backed; cheap because the
  source we read from is the pre-extracted mic WAV (small, fast-seekable).

Override key shape: ``(kind, source_id)`` where:
- ``kind`` ∈ ``"pause"`` | ``"filler"`` | ``"retake"``
- ``source_id`` is the classifier's ``id`` field for pauses/fillers, or the
  list-index for retakes (they don't carry their own ids).

Override value shape:
- For pauses: one of ``"cut"`` / ``"trim"`` / ``"keep"`` — overrides the
  ``action`` field on the matching ``ClassifiedPause``.
- For fillers: ``"cut"`` / ``"keep"`` — overrides ``action`` on
  ``ClassifiedFiller``.
- For retakes: ``"reject"`` drops the retake from the list. (There's no
  "rewrite the keep/cut ranges" override; that needs a richer editor.)
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Literal

from .models import Classification, ClassifiedFiller, ClassifiedPause

OverrideKind = Literal["pause", "filler", "retake"]
OverrideKey = tuple[OverrideKind, int]
OverrideValue = str  # pause: cut/trim/keep ; filler: cut/keep ; retake: accept/reject


def apply_overrides(
    classification: Classification,
    overrides: dict[OverrideKey, OverrideValue],
) -> Classification:
    """Return a new Classification with the user's per-item overrides applied.

    The original is not mutated. Items without an override are passed through
    unchanged. Unknown override values are silently ignored (defensive — the
    UI shouldn't produce them).
    """

    def _pause_override(p: ClassifiedPause) -> ClassifiedPause:
        new_action = overrides.get(("pause", p.id))
        if new_action not in ("cut", "trim", "keep"):
            return p
        # Wipe trim_to_ms when the action is no longer "trim" so downstream
        # consumers don't see a stale millisecond hint.
        new_trim = p.trim_to_ms if new_action == "trim" else None
        return p.model_copy(update={"action": new_action, "trim_to_ms": new_trim})

    def _filler_override(f: ClassifiedFiller) -> ClassifiedFiller:
        new_action = overrides.get(("filler", f.id))
        if new_action not in ("cut", "keep"):
            return f
        return f.model_copy(update={"action": new_action})

    new_pauses = [_pause_override(p) for p in classification.pauses]
    new_fillers = [_filler_override(f) for f in classification.fillers]
    new_retakes = [
        r for i, r in enumerate(classification.retakes)
        if overrides.get(("retake", i)) != "reject"
    ]
    return Classification(pauses=new_pauses, fillers=new_fillers, retakes=new_retakes)


def extract_audio_clip(
    audio_path: Path,
    start_seconds: float,
    end_seconds: float,
    pad_seconds: float = 1.5,
) -> bytes:
    """Extract a short MP3 clip around [start, end] for inline playback.

    Operates on the mic-only WAV from ingest (small file, fast seek), not the
    source video. The returned bytes are MP3 (browser-friendly).
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found on PATH")
    clip_start = max(0.0, start_seconds - pad_seconds)
    clip_end = end_seconds + pad_seconds
    # `-ss` before `-i` does fast (keyframe-aligned) seek. For audio that's
    # equivalent to precise seek and is much faster than -ss after -i.
    proc = subprocess.run(
        [
            ffmpeg, "-v", "error",
            "-ss", f"{clip_start:.3f}",
            "-to", f"{clip_end:.3f}",
            "-i", str(audio_path),
            "-vn",
            "-c:a", "libmp3lame",
            "-b:a", "96k",
            "-f", "mp3",
            "-",
        ],
        capture_output=True,
        check=True,
    )
    return proc.stdout
