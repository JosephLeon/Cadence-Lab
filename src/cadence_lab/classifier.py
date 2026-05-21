"""Stage 3 — pause / filler / retake classification with Claude.

Takes a ``SpeechAnalysis`` (from stage 2) and:

1. Pre-computes every between-word pause above a threshold (e.g. > 250 ms),
   assigning each one a stable ID.
2. Scans the transcript for candidate filler tokens ("um", "uh", "like", etc.),
   assigning each one a stable ID.
3. Builds an annotated transcript where pauses and filler candidates are marked
   inline by ID, in their original time positions.
4. Sends the annotated transcript to Claude Opus 4.7 with a frozen classification
   rubric (cached) and an enforced JSON output schema.
5. Returns a ``ClassificationBundle`` — the candidates plus Claude's per-item
   category + action + reason, ready for the cut planner (stage 4) to consume.

Design notes:
- Pre-flagging filler candidates (rather than asking Claude to find them in
  free text) keeps the response space bounded and the cut planner deterministic:
  every candidate the LLM saw has an explicit cut/keep decision attached.
- Pauses are computed from word timestamps, not VAD regions, because we want
  word-aligned cut boundaries — VAD tells us "where speech is", word timestamps
  tell us "where words are", and the latter is what the editor actually cuts on.
- The system prompt is wrapped in a ``cache_control`` block so re-classifying
  more videos with the same rubric reads from the cache (~0.1× cost).
- Streaming is used because Opus 4.7 + adaptive thinking + ``effort: high`` on
  a ~25K-token transcript can exceed the SDK's non-streaming timeout estimate.
"""

from __future__ import annotations

import json
import os
from typing import Callable

import anthropic
from dotenv import load_dotenv

from .models import (
    Classification,
    ClassificationBundle,
    FillerCandidate,
    PauseCandidate,
    SpeechAnalysis,
)

load_dotenv()

CLASSIFIER_MODEL = "claude-opus-4-7"

# Pauses shorter than this are treated as natural inter-word spacing and not
# classified. 250 ms is around the threshold for noticeably perceptible gaps.
MIN_PAUSE_SECONDS = 0.25

# Single-word candidates. Claude judges each in context — we are intentionally
# liberal here ("like" / "actually" / "literally" are often *not* filler).
FILLER_TOKENS: frozenset[str] = frozenset({
    "um", "umm", "ummm",
    "uh", "uhh", "uhhh",
    "er", "erm", "ah", "hm", "hmm", "mmm",
    "like",
    "basically",
    "literally",
    "actually",
})

# Throttle interval for progress-callback ticks during streaming.
_PROGRESS_TICK_CHARS = 800

ProgressFn = Callable[[float, str], None]


# ─── Pre-processing ──────────────────────────────────────────────────────────


def find_pauses(
    speech: SpeechAnalysis,
    min_seconds: float = MIN_PAUSE_SECONDS,
) -> list[PauseCandidate]:
    """Compute every between-word gap >= ``min_seconds``."""
    words = speech.words
    out: list[PauseCandidate] = []
    next_id = 0
    for i in range(len(words) - 1):
        gap = words[i + 1].start - words[i].end
        if gap >= min_seconds:
            out.append(PauseCandidate(
                id=next_id,
                start=words[i].end,
                end=words[i + 1].start,
            ))
            next_id += 1
    return out


def find_fillers(speech: SpeechAnalysis) -> list[FillerCandidate]:
    """Scan the transcript for words matching the filler-token set."""
    out: list[FillerCandidate] = []
    next_id = 0
    for word_idx, word in enumerate(speech.words):
        normalized = word.text.strip().lower().strip(".,!?;:\"'()[]{}—-…")
        if normalized in FILLER_TOKENS:
            out.append(FillerCandidate(
                id=next_id,
                word_index=word_idx,
                text=word.text.strip(),
                start=word.start,
                end=word.end,
            ))
            next_id += 1
    return out


# ─── Annotated-transcript builder ────────────────────────────────────────────


def _fmt_ts(s: float) -> str:
    m = int(s // 60)
    sec = s - m * 60
    return f"{m:02d}:{sec:05.2f}"


def build_annotated_transcript(
    speech: SpeechAnalysis,
    pauses: list[PauseCandidate],
    fillers: list[FillerCandidate],
) -> str:
    """Inline pause and filler markers into the transcript.

    Output format:

        [00:00.00] Hello «P:0 (0.52s)» everyone, «F:0:"um"» welcome.
        [00:15.32] More text «P:5 (1.10s)» continuing here.

    The markers are unambiguous (won't appear in natural speech) and carry
    enough information for Claude to classify each item without round-trips.
    """
    fillers_by_word = {f.word_index: f for f in fillers}
    pauses_sorted = sorted(pauses, key=lambda p: p.start)
    pause_cursor = 0

    out: list[str] = [f"[{_fmt_ts(0.0)}]"]
    last_ts_emit = 0.0

    for word_idx, word in enumerate(speech.words):
        # Drain any pauses that fall before this word's start.
        while (pause_cursor < len(pauses_sorted)
               and pauses_sorted[pause_cursor].end <= word.start + 0.001):
            p = pauses_sorted[pause_cursor]
            out.append(f" «P:{p.id} ({p.duration:.2f}s)»")
            pause_cursor += 1

        # Emit a fresh timestamp marker every ~15 seconds so Claude has
        # coarse-grained position info without needing to count words.
        if word.start - last_ts_emit > 15.0:
            out.append(f"\n[{_fmt_ts(word.start)}]")
            last_ts_emit = word.start

        word_text = word.text.lstrip()  # Whisper words usually carry a leading space
        if word_idx in fillers_by_word:
            f = fillers_by_word[word_idx]
            out.append(f' «F:{f.id}:"{word_text}"»')
        else:
            out.append(f" {word_text}")

    # Tail pauses, if any.
    while pause_cursor < len(pauses_sorted):
        p = pauses_sorted[pause_cursor]
        out.append(f" «P:{p.id} ({p.duration:.2f}s)»")
        pause_cursor += 1

    return "".join(out).strip()


# ─── Claude call ─────────────────────────────────────────────────────────────


SYSTEM_PROMPT = """You are an expert video editor reviewing a YouTube creator's screen-recording (single camera with a small picture-in-picture face cam). The creator wants tight, well-paced edits that still feel natural — not robotic. Your job is to classify every PAUSE and CANDIDATE FILLER WORD in the transcript below so the editing system knows what to cut.

## Classification rubric

### Pauses (gaps between words, marked «P:N (Xs)»)

Each pause needs a category, action, and brief reason:

- "filler" — empty thinking pause with no semantic purpose, often mid-sentence
  → action: "cut"
- "hesitation" — speaker visibly searching for words, mid-sentence stumble
  → action: "cut"
- "breath" — natural inhale/exhale, typically at a sentence boundary
  → action: "trim", trim_to_ms: 150
  → DO NOT cut breaths entirely. That sounds robotic. Trim, don't delete.
- "emphasis" — intentional dramatic beat before or after a key word
  → action: "keep"
- "pre_laughter" — the speaker is about to laugh or has just smiled
  → action: "keep"
- "transition" — pause between topics or major thought shifts
  → action: "keep" (or rarely "trim" with trim_to_ms: 500 for very long ones)
- "listening" — waiting for an off-camera cue (rare in solo recordings)
  → action: "keep"

When in doubt on a pause: lean toward "cut". The creator wants pace.

### Filler words (marked «F:M:"word"»)

Each candidate is a word that *might* be filler. Classify each as:

- "cut" — yes, this is empty filler in this context
- "keep" — no, this word is meaningful here

When in doubt on a filler word: lean toward "keep". Words like "like", "actually", "literally", "basically" are frequently meaningful — only cut when the word is clearly hesitation filler ("um", "uh") or genuinely vestigial in context.

### Retakes

Spot places where the speaker repeated themselves or restarted. Signals:
- explicit cues: "let me try that again", "wait, start over", "no, what I meant was", "scratch that"
- two consecutive attempts at the same sentence (the second usually cleaner)

For each retake, output the segment to CUT (the first attempt) and the segment to KEEP (the clean take), with timestamps in seconds.

## Output format

Respond with a JSON object matching the provided schema. Use the IDs from the markers (P:N for pauses, F:M for fillers). The `reason` field is shown to the creator in a review UI — keep it specific and under 12 words. "Thinking pause mid-sentence" is good; "filler" alone is not."""


# JSON Schema for the structured output. Mirrors the Pydantic models exactly.
_CLASSIFICATION_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": ["pauses", "fillers", "retakes"],
    "properties": {
        "pauses": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "category", "action", "trim_to_ms", "reason"],
                "properties": {
                    "id": {"type": "integer"},
                    "category": {"enum": [
                        "filler", "hesitation", "breath", "emphasis",
                        "pre_laughter", "transition", "listening",
                    ]},
                    "action": {"enum": ["cut", "trim", "keep"]},
                    "trim_to_ms": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
                    "reason": {"type": "string"},
                },
            },
        },
        "fillers": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "action", "reason"],
                "properties": {
                    "id": {"type": "integer"},
                    "action": {"enum": ["cut", "keep"]},
                    "reason": {"type": "string"},
                },
            },
        },
        "retakes": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "cut_start", "cut_end", "keep_start", "keep_end", "reason"
                ],
                "properties": {
                    "cut_start": {"type": "number"},
                    "cut_end": {"type": "number"},
                    "keep_start": {"type": "number"},
                    "keep_end": {"type": "number"},
                    "reason": {"type": "string"},
                },
            },
        },
    },
}


def _build_user_message(
    speech: SpeechAnalysis,
    pauses: list[PauseCandidate],
    fillers: list[FillerCandidate],
    min_pause_seconds: float,
) -> str:
    transcript = build_annotated_transcript(speech, pauses, fillers)
    return (
        f"DURATION: {_fmt_ts(speech.duration_seconds)}\n"
        f"TOTAL_PAUSES: {len(pauses)} (gaps >= {int(min_pause_seconds * 1000)}ms)\n"
        f"TOTAL_FILLER_CANDIDATES: {len(fillers)}\n\n"
        f'TRANSCRIPT (pauses marked «P:N (Xs)», filler candidates «F:M:"word"»):\n\n'
        f"{transcript}\n"
    )


def classify(
    speech: SpeechAnalysis,
    min_pause_seconds: float = MIN_PAUSE_SECONDS,
    progress: ProgressFn | None = None,
) -> ClassificationBundle:
    """Run pause + filler + retake classification on a stage-2 speech analysis."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example)."
        )

    if progress:
        progress(0.0, "Computing pause and filler candidates...")
    pauses = find_pauses(speech, min_seconds=min_pause_seconds)
    fillers = find_fillers(speech)

    if progress:
        progress(
            0.05,
            f"Found {len(pauses)} pauses, {len(fillers)} filler candidates — "
            f"asking {CLASSIFIER_MODEL} to classify...",
        )

    user_message = _build_user_message(speech, pauses, fillers, min_pause_seconds)
    client = anthropic.Anthropic(api_key=api_key)

    chars = 0
    saw_text = False

    with client.messages.stream(
        model=CLASSIFIER_MODEL,
        max_tokens=32000,
        thinking={"type": "adaptive"},
        output_config={
            "effort": "high",
            "format": {"type": "json_schema", "schema": _CLASSIFICATION_SCHEMA},
        },
        system=[{
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{"role": "user", "content": user_message}],
    ) as stream:
        for event in stream:
            etype = event.type
            if etype == "content_block_start":
                block = event.content_block
                if block.type == "thinking" and progress:
                    progress(0.15, "Reasoning about pauses and fillers...")
                elif block.type == "text" and progress:
                    saw_text = True
                    progress(0.55, "Writing classification...")
            elif etype == "content_block_delta":
                delta = event.delta
                if delta.type == "text_delta":
                    chars += len(delta.text)
                    if progress and chars % _PROGRESS_TICK_CHARS < 50:
                        # Heuristic completion estimate: cap at 0.95 so the
                        # final-message step can drive it to 1.0.
                        frac = min(0.55 + (chars / 30000), 0.95)
                        progress(frac, f"Writing classification... ({chars} chars)")
        final = stream.get_final_message()

    text_block = next((b for b in final.content if b.type == "text"), None)
    if text_block is None:
        raise RuntimeError(
            "Claude returned no text block. stop_reason="
            f"{final.stop_reason!r}"
        )
    data = json.loads(text_block.text)
    classification = Classification.model_validate(data)

    usage = final.usage
    bundle = ClassificationBundle(
        pause_candidates=pauses,
        filler_candidates=fillers,
        classification=classification,
        model_used=CLASSIFIER_MODEL,
        input_tokens=getattr(usage, "input_tokens", 0) or 0,
        output_tokens=getattr(usage, "output_tokens", 0) or 0,
        cache_read_input_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
        cache_creation_input_tokens=(
            getattr(usage, "cache_creation_input_tokens", 0) or 0
        ),
    )

    if progress:
        cls = bundle.classification
        cut_pauses = sum(1 for p in cls.pauses if p.action == "cut")
        trim_pauses = sum(1 for p in cls.pauses if p.action == "trim")
        keep_pauses = sum(1 for p in cls.pauses if p.action == "keep")
        cut_fillers = sum(1 for f in cls.fillers if f.action == "cut")
        progress(
            1.0,
            f"Done. Pauses: {cut_pauses} cut / {trim_pauses} trim / {keep_pauses} keep. "
            f"Fillers: {cut_fillers}/{len(cls.fillers)} cut. "
            f"Retakes: {len(cls.retakes)}. "
            f"({bundle.input_tokens} in / {bundle.output_tokens} out, "
            f"cache_read={bundle.cache_read_input_tokens})",
        )

    return bundle
