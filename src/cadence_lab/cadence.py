"""Ask Cadence — natural-language editing of the active project.

Claude reads project state via a small set of **read tools** (transcript,
pauses, fillers, classification) and proposes edits via **action tools**.
Action tools don't execute server-side; they're recorded and returned to
the frontend, which renders them as proposal cards the user explicitly
applies.

This split keeps the user in control: read tools are "free" introspection,
action tools require a click. The same Claude call can do both — gather
context with read tools first, then propose edits.

Phase 1 scope: pacing/audio edits on a single active source. Multi-source
operations and splice-timeline edits come later.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import anthropic

from .models import AnalysisBundle, ClassificationBundle
from .projects import Project, project_dir_path, resolve_source


CADENCE_MODEL = "claude-opus-4-7"

SYSTEM_PROMPT = """You are Cadence, the AI editor inside Cadence Lab.
You help a YouTuber edit their videos by proposing concrete edits to the
active project. Each turn you receive:

- A short project digest (sources, renders, active source, pipeline state).
- The user's request in natural language.

Your job is to figure out **what specific edits to propose** to fulfill the
request, then call the appropriate tools.

You have two kinds of tools:

- **Read tools** (list_pauses, list_fillers, get_transcript_around,
  get_classification_summary): these fetch project state so you can locate
  the thing the user mentioned ("the um at 1:23", "the long pause around
  5:00"). Use them freely — they cost nothing.

- **Propose tools** (propose_*): these don't apply edits directly. They
  *record* a proposed edit. The user reviews and applies them in the UI.
  Be specific in the `summary` field — that's the only thing the user
  sees before clicking Apply.

## What you CAN edit

You have four mutation tools:

- `propose_set_override` — flip a classifier-detected pause or filler to
  cut / trim / keep / reject. Best when the thing the user wants to edit
  is already in `list_pauses` or `list_fillers`; integrates with the
  classifier's logic and audit trail.

- `propose_add_custom_cut(start, end, summary)` — cut an arbitrary
  source-time range. Use this when the content the user wants to remove
  *isn't* in pauses/fillers (mistranscribed sounds, unflagged repeated
  words, botched sentences, etc.). Get the exact times from
  `get_transcript_around` — look at the `start`/`end` of each word.

- `propose_create_highlight_clip(start, end, title, summary)` — extract a
  range as a standalone clip that drops into the splice timeline. Use for
  "make a 1-min YouTube clip", "find the best moment", "pull out a viral
  hook". Always call `get_full_transcript` first so you can pick ranges
  based on actual content. Propose 2–5 candidates, not one — let the user
  pick.

- `propose_set_audio_setting` — enhance_speech, enhance_engine
  (classical=fast ffmpeg afftdn, neural=DeepFilterNet better on real-world
  noise but slower), auto_duck, ducking_db.

You **cannot** (yet): modify the splice timeline, add/remove blanks, move
clips, or trigger renders directly.

## Visual search ("find when X is on screen")

CLIP frame embeddings power semantic search over what the camera sees —
use `search_video_content` for queries like "find the walnut table",
"find when the dog appears", "where is the speaker laughing".

1. Call `search_video_content(query=...)` with a specific, concrete
   description. CLIP rewards specifics: "walnut table" beats "table";
   "person in a red jacket" beats "person".
2. If it returns `status: "needs_index"`, tell the user that visual
   search needs a one-time indexing pass (~1 min per 5 min of video)
   and call `propose_run_visual_index` with a clear summary. The
   conversation will auto-resume when indexing completes.
3. If it returns results, present the top 3-5 as a brief text list with
   timestamps. Don't pretend you can see the frames — you only have
   similarity scores. Caveats matter: a low score (~0.20-0.25) means
   "best guess but not confident"; ~0.30+ is a likely real match.
4. Visual search **doesn't propose cuts on its own**. If the user wants
   to act on a result (cut, highlight clip, etc.), follow up with the
   appropriate propose tool.

When to NOT use visual search:
- "What did the speaker say about X?" → use `get_full_transcript`
- "Where's that um at 1:23?" → use `list_fillers`
- "Cut the throat clear" → use `list_audio_events`

## Audio events (sniffles, throat clears, coughs, lip smacks)

These aren't in the speech transcript or the classifier's filler list —
they're non-speech sounds. There's a separate **opt-in scan** that
detects them; once it's been run, `list_audio_events` returns the
results. If a user asks to remove sniffles/coughs/etc:

1. Call `list_audio_events` (filter by `kinds` to what the user asked
   for). If it returns `status: "needs_scan"`, tell the user the
   detection pass needs to run (~1-3 min for typical videos) and call
   `propose_run_audio_event_scan` with a clear summary. The user has
   to Apply it explicitly.
2. **After the scan completes the system automatically sends you a
   follow-up message** of the form: `(Audio-event scan complete — N
   events found.) Continue with the previous request: "<original>"`.
   When you see this, call `list_audio_events` again with the same
   filter and proceed to step 3. The user doesn't have to retype
   anything.
3. With events in hand, propose `propose_add_custom_cut` for each
   event matching what the user asked to remove. Use the event's
   `start` and `end` directly; include the `kind` and timestamp in the
   summary so the user can verify before applying.

## Choosing the right tool

| If the user wants to...                                    | Use                              |
|------------------------------------------------------------|----------------------------------|
| Cut a classifier-detected pause/filler                     | `propose_set_override`           |
| Cut a specific word/phrase in the transcript               | `propose_add_custom_cut`         |
| Cut arbitrary unflagged content (vocalizations, noises)    | `propose_add_custom_cut`         |
| Extract a short clip for YouTube / social / a compilation  | `propose_create_highlight_clip`  |
| Change audio enhancement settings                          | `propose_set_audio_setting`      |
| Remove sniffles / throat clears / coughs / lip smacks      | `list_audio_events` → `propose_add_custom_cut` per event |
| Find moments by what's on screen (visual search)           | `search_video_content` |

For custom cuts, **always use `get_transcript_around` first** to find the
exact word boundaries, then propose the cut with those timestamps.

For highlight extraction, **always use `get_full_transcript` first** to
scan the whole video, then pick 2–5 ranges based on engagement signals:

- **Complete thoughts** — never start mid-sentence. End at a natural beat.
- **Hooks/payoffs/tension** — a question that gets answered, a stakes-setup
  → punchline, a contradiction the speaker resolves.
- **Energy spikes** — moments where the speaker raises their voice,
  laughs, or speeds up.
- **Memorable lines** — quotable one-liners, surprising statements, key
  conclusions.

Avoid: dead-air openings, "so" / "anyway" segues, half-thoughts that
require earlier context the viewer doesn't have.

Default duration: 30-60s per clip if user doesn't specify. If they say
"1 minute", target 50-70s. Don't cut to exact duration at the expense of
ending mid-sentence.

## Guidelines

1. **Whisper isn't always right.** The transcript is the best signal we
   have for what's in the audio, but Whisper sometimes mistranscribes
   non-speech vocalizations (a sustained vowel might come back as "Oh"
   when the user actually said "do do do"). If the user contradicts the
   transcript, trust them — they were there. Propose the cut based on
   the time range they specified.

2. **Be precise about time.** When proposing a custom cut, get the
   word-level start/end from `get_transcript_around` if you can. Don't
   round to whole seconds — sub-second precision matters.

3. **Don't ask, propose.** The user explicitly invoked you to make
   changes. Propose the edit; the user will reject it if wrong. Asking
   "should I cut this?" wastes a turn — propose it and explain in the
   summary.

4. **Chain proposals when needed.** If the user says "remove all ums",
   list the fillers, then call `propose_set_override` once per um.

5. **End with a short text confirmation** — what you proposed and why.
   The proposed actions show up automatically in the UI; your text is
   just human-readable context.

6. **Refuse cleanly** for capabilities we don't have yet (semantic media
   search, audio-event detection for sniffles/throat-clears, computer
   vision). Briefly explain why and suggest a workaround.
"""


# ─── Tool schemas ────────────────────────────────────────────────────────────

READ_TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_pauses",
        "description": (
            "List silent pauses detected in the active source. Use this to "
            "locate pauses by approximate timestamp before proposing a "
            "cut/trim override."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "min_seconds": {
                    "type": "number",
                    "description": "Minimum pause duration to include (default 0.5).",
                },
                "near_time": {
                    "type": "number",
                    "description": (
                        "Optional: only return pauses within ±5s of this "
                        "timestamp (seconds into the source)."
                    ),
                },
            },
        },
    },
    {
        "name": "list_fillers",
        "description": (
            "List filler-word candidates (ums, uhs, you-knows) detected by "
            "Whisper. Use this to find a specific filler the user wants to "
            "remove."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "text_contains": {
                    "type": "string",
                    "description": (
                        "Filter to fillers whose text matches (case-insensitive "
                        "substring). E.g. 'um' matches 'um' and 'ums'."
                    ),
                },
                "near_time": {
                    "type": "number",
                    "description": (
                        "Optional: only return fillers within ±3s of this "
                        "timestamp."
                    ),
                },
            },
        },
    },
    {
        "name": "get_transcript_around",
        "description": (
            "Return the spoken words around a given timestamp. Useful for "
            "context when the user references content rather than time."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "time": {
                    "type": "number",
                    "description": "Center timestamp in seconds.",
                },
                "window_seconds": {
                    "type": "number",
                    "description": "Half-window size; default 5.",
                },
            },
            "required": ["time"],
        },
    },
    {
        "name": "get_classification_summary",
        "description": (
            "Return counts of pauses, fillers, retakes, and current "
            "classifier actions. Cheap overview to orient yourself."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "search_video_content",
        "description": (
            "Visually search the active source video for moments matching "
            "a natural-language description. Uses CLIP frame embeddings.\n\n"
            "Use this for queries about *what's on screen*: 'find when the "
            "walnut table is shown', 'find the part where the speaker is "
            "laughing', 'where does the dog appear'. Don't use for transcript "
            "lookups — `get_transcript_around` is faster and more accurate.\n\n"
            "Returns ranked `{time, score}` entries (score is cosine "
            "similarity; ~0.25+ is a decent visual match, ~0.30+ is strong).\n\n"
            "If the source hasn't been indexed yet, this returns "
            "`{ status: 'needs_index' }`. In that case, tell the user the "
            "visual index needs to be built (~1 min per 5 min of video) "
            "and offer to kick it off via `propose_run_visual_index`."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Plain-English description of what to find on "
                        "screen. Be specific: 'walnut table' > 'table'; "
                        "'person laughing' > 'laughing'."
                    ),
                },
                "top_k": {
                    "type": "integer",
                    "description": "How many ranked matches to return (default 5, max 20).",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "list_audio_events",
        "description": (
            "List non-speech audio events (sniffles, throat clears, coughs, "
            "lip smacks, etc.) detected by the opt-in event-detection pass. "
            "Returns events with `start`, `end`, `kind`, and `confidence`. "
            "Use this when the user asks about removing non-speech sounds.\n\n"
            "If the scan hasn't been run yet, this returns "
            "`{ status: 'needs_scan' }`. In that case, tell the user the "
            "scan needs to run (~2 minutes for a 30-min video) and offer "
            "to kick it off via `propose_run_audio_event_scan`."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "kinds": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Optional filter — only return events of these kinds. "
                        "Valid kinds: sniff, throat_clear, cough, sneeze, "
                        "hiccup, burp."
                    ),
                },
                "min_confidence": {
                    "type": "number",
                    "description": "Filter out events below this confidence (0–1).",
                },
            },
        },
    },
    {
        "name": "get_full_transcript",
        "description": (
            "Return the FULL transcript of the active source as a list of "
            "segments with word-level timestamps. Use this for highlight "
            "extraction or any task that needs to scan the whole video. "
            "Output is condensed (one line per segment with start/end + text) "
            "to keep token cost reasonable."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
]

ACTION_TOOLS: list[dict[str, Any]] = [
    {
        "name": "propose_run_visual_index",
        "description": (
            "Propose building the visual search index (CLIP frame "
            "embeddings) on the active source. Only use when "
            "`search_video_content` returns `needs_index` and the user "
            "agrees to wait (~1 min per 5 min of source video). The user "
            "must explicitly Apply. Once it completes the system will "
            "auto-continue the conversation."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "summary": {
                    "type": "string",
                    "description": (
                        "One-line summary, e.g. 'Build visual search "
                        "index (~3 min) so we can find when the walnut "
                        "table is on screen.'"
                    ),
                },
            },
            "required": ["summary"],
        },
    },
    {
        "name": "propose_run_audio_event_scan",
        "description": (
            "Propose running the (slow, opt-in) audio-event detection pass "
            "on the active source. Only use when `list_audio_events` returns "
            "`needs_scan` and the user has agreed to wait for it. The user "
            "must explicitly Apply this action — it kicks off a ~1-3 minute "
            "background job. Once it completes the user can re-ask their "
            "question and you can read the results via `list_audio_events`."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "summary": {
                    "type": "string",
                    "description": (
                        "One-line summary, e.g. 'Run audio-event scan "
                        "(~2 min) so we can find sniffles in this video.'"
                    ),
                },
            },
            "required": ["summary"],
        },
    },
    {
        "name": "propose_create_highlight_clip",
        "description": (
            "Propose extracting a highlight clip from the active source. "
            "When applied, this adds a clip to the splice timeline covering "
            "the given source-time range — the user can then export it as "
            "a standalone short, or combine it with other highlights into a "
            "compilation.\n\n"
            "Use for requests like 'make a 1-minute YouTube clip', 'pull out "
            "the best moments', 'find a viral hook'. Always read the full "
            "transcript first via `get_full_transcript`, then pick ranges "
            "based on engagement: complete thoughts (not mid-sentence), "
            "hooks/payoffs/tension, energy spikes, memorable lines. Propose "
            "2–5 candidates with titles so the user can pick — don't propose "
            "one and stop.\n\n"
            "Respect the user's duration ask within ~10%. If they say "
            "'1 minute', target 50-70s. Default duration when unspecified: "
            "30-60s per clip."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start": {
                    "type": "number",
                    "description": "Start time in source seconds.",
                },
                "end": {
                    "type": "number",
                    "description": "End time in source seconds (must be > start).",
                },
                "title": {
                    "type": "string",
                    "description": (
                        "Short clip title shown in the splice timeline "
                        "header. 4-8 words, captures the hook. E.g. "
                        "\"The 'aha' moment about pacing\" or \"Why I "
                        "switched from Final Cut\"."
                    ),
                },
                "summary": {
                    "type": "string",
                    "description": (
                        "One-line description shown in the proposal card. "
                        "Include the time range and why this clip works. "
                        "E.g. \"Add highlight (1:22-2:05): the punchline "
                        "lands cleanly and the energy peaks here.\""
                    ),
                },
            },
            "required": ["start", "end", "title", "summary"],
        },
    },
    {
        "name": "propose_add_custom_cut",
        "description": (
            "Propose cutting an arbitrary time range from the active source. "
            "Use this when the user wants to remove content that ISN'T already "
            "in list_pauses or list_fillers — e.g. a mistranscribed sound, a "
            "repeated 'do do do' that the classifier didn't tag, or a botched "
            "sentence the user wants gone. Get the time range from "
            "get_transcript_around (look at the word `start`/`end` fields). "
            "Don't use this for content that IS in fillers/pauses — use "
            "propose_set_override there, it composes better with the "
            "classifier's logic."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start": {
                    "type": "number",
                    "description": "Start time in source seconds.",
                },
                "end": {
                    "type": "number",
                    "description": "End time in source seconds (must be > start).",
                },
                "summary": {
                    "type": "string",
                    "description": (
                        "Human-readable summary, e.g. \"Cut the 'do do do' "
                        "vocalization (29.0s-29.9s)\"."
                    ),
                },
            },
            "required": ["start", "end", "summary"],
        },
    },
    {
        "name": "propose_set_override",
        "description": (
            "Propose an override for a single pause or filler. Keys look "
            "like 'pause:5' or 'filler:12' — get them from list_pauses or "
            "list_fillers. Valid values: 'cut' (remove entirely), 'trim' "
            "(replace with default breath, pauses only), 'keep' (revert "
            "classifier default), 'reject' (retakes only)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": "Override key from list_pauses/list_fillers, e.g. 'filler:3'.",
                },
                "value": {
                    "type": "string",
                    "enum": ["cut", "trim", "keep", "reject"],
                },
                "summary": {
                    "type": "string",
                    "description": (
                        "One-line human-readable description shown to the "
                        "user before they apply. Include the timestamp and "
                        "what's being changed."
                    ),
                },
            },
            "required": ["key", "value", "summary"],
        },
    },
    {
        "name": "propose_set_audio_setting",
        "description": (
            "Propose changing an audio enhancement setting on the active "
            "source. Settings: enhance_speech (off/low/medium/high), "
            "enhance_engine (classical/neural — neural=DeepFilterNet, "
            "noticeably better on real-world noise but slower; classical="
            "fast ffmpeg afftdn), auto_duck (true/false), ducking_db (-24 "
            "to -2)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "setting": {
                    "type": "string",
                    "enum": [
                        "enhance_speech",
                        "enhance_engine",
                        "auto_duck",
                        "ducking_db",
                    ],
                },
                "value": {
                    "description": (
                        "New value. String for enhance_speech "
                        "(off/low/medium/high) or enhance_engine "
                        "(classical/neural), bool for auto_duck, number "
                        "for ducking_db."
                    ),
                },
                "summary": {"type": "string"},
            },
            "required": ["setting", "value", "summary"],
        },
    },
]

ALL_TOOLS = READ_TOOLS + ACTION_TOOLS


# ─── Request / response types ────────────────────────────────────────────────


@dataclass
class CadenceMessage:
    """One turn of conversation. Role is `user` or `assistant`."""
    role: Literal["user", "assistant"]
    text: str


@dataclass
class ProposedAction:
    """An action Cadence wants the user to apply. Frontend renders these as
    cards and maps them to store actions."""
    type: str
    summary: str
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class CadenceResponse:
    """One assistant turn: text plus any actions it proposed."""
    text: str
    actions: list[ProposedAction] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0


# ─── Read-tool dispatch (executes server-side) ───────────────────────────────


@dataclass
class CadenceContext:
    """The slice of project state Cadence's read tools operate on."""
    project: Project
    active_source_rel: str | None  # project-relative path of AI-active source

    def active_source_abs(self) -> Path | None:
        if not self.active_source_rel:
            return None
        # Find the SourceEntry to resolve via ref_mode
        for s in self.project.sources:
            if s.path == self.active_source_rel:
                return resolve_source(self.project, s)
        # Fallback: treat as project-relative
        return project_dir_path(self.project.slug) / self.active_source_rel


def _load_analysis(ctx: CadenceContext) -> AnalysisBundle | None:
    abs_src = ctx.active_source_abs()
    if not abs_src:
        return None
    from .paths import analysis_path

    ap = analysis_path(abs_src)
    if not ap.exists():
        return None
    return AnalysisBundle.model_validate_json(ap.read_text())


def _load_classification(ctx: CadenceContext) -> ClassificationBundle | None:
    abs_src = ctx.active_source_abs()
    if not abs_src:
        return None
    from .paths import classified_path

    cp = classified_path(abs_src)
    if not cp.exists():
        return None
    return ClassificationBundle.model_validate_json(cp.read_text())


def _dispatch_read_tool(
    name: str, args: dict[str, Any], ctx: CadenceContext
) -> dict[str, Any] | str:
    """Execute a read tool and return a JSON-serializable result. String
    return = error message Claude will see as the tool_result."""
    bundle = _load_classification(ctx)
    if bundle is None and name in ("list_pauses", "list_fillers", "get_classification_summary"):
        return (
            "No classification available for the active source. The user "
            "must run the pipeline (Analyze → Classify → Plan) first."
        )

    if name == "list_pauses":
        if bundle is None:
            return "no classification"
        min_s = float(args.get("min_seconds") or 0.5)
        near = args.get("near_time")
        out: list[dict[str, Any]] = []
        # Map pause_candidates against the classification action for each.
        actions_by_id = {p.id: p for p in bundle.classification.pauses}
        for p in bundle.pause_candidates:
            dur = p.end - p.start
            if dur < min_s:
                continue
            if near is not None and abs(p.start - near) > 5 and abs(p.end - near) > 5:
                continue
            act = actions_by_id.get(p.id)
            out.append({
                "id": p.id,
                "key": f"pause:{p.id}",
                "start": round(p.start, 2),
                "end": round(p.end, 2),
                "duration": round(dur, 2),
                "classifier_action": act.action if act else "keep",
                "classifier_reason": act.reason if act else "",
            })
        return {"pauses": out}

    if name == "list_fillers":
        if bundle is None:
            return "no classification"
        substr = (args.get("text_contains") or "").lower()
        near = args.get("near_time")
        out_f: list[dict[str, Any]] = []
        actions_by_id = {f.id: f for f in bundle.classification.fillers}
        for f in bundle.filler_candidates:
            if substr and substr not in f.text.lower():
                continue
            if near is not None and abs(f.start - near) > 3 and abs(f.end - near) > 3:
                continue
            act = actions_by_id.get(f.id)
            out_f.append({
                "id": f.id,
                "key": f"filler:{f.id}",
                "text": f.text,
                "start": round(f.start, 2),
                "end": round(f.end, 2),
                "classifier_action": act.action if act else "keep",
                "classifier_reason": act.reason if act else "",
            })
        return {"fillers": out_f}

    if name == "get_transcript_around":
        analysis = _load_analysis(ctx)
        if analysis is None:
            return "no analysis available for the active source"
        t = float(args.get("time", 0.0))
        win = float(args.get("window_seconds") or 5.0)
        words = []
        for seg in analysis.speech.segments:
            for w in seg.words:
                if w.end >= t - win and w.start <= t + win:
                    words.append({
                        "text": w.text,
                        "start": round(w.start, 2),
                        "end": round(w.end, 2),
                    })
        return {"window_start": t - win, "window_end": t + win, "words": words}

    if name == "search_video_content":
        from .paths import frame_index_path
        from .vision import search as vision_search

        abs_src = ctx.active_source_abs()
        if not abs_src:
            return "No active source. The user needs to load one in the AI tab."
        idx = frame_index_path(abs_src)
        if not idx.exists():
            return {
                "status": "needs_index",
                "message": (
                    "Visual search index hasn't been built for this source. "
                    "Propose `propose_run_visual_index` to kick it off."
                ),
            }
        query = (args.get("query") or "").strip()
        if not query:
            return "search_video_content requires a non-empty `query`."
        top_k = max(1, min(int(args.get("top_k") or 5), 20))
        try:
            results = vision_search(idx, query, top_k=top_k)
        except Exception as e:
            return f"search failed: {e}"
        return {
            "status": "ok",
            "query": query,
            "results": results,
            "note": (
                "Scores are CLIP cosine similarity; ~0.25 is a decent "
                "match, ~0.30 is strong. Empty results mean the model "
                "didn't see anything resembling the query above the "
                "threshold (0.20)."
            ),
        }

    if name == "list_audio_events":
        from .models import AudioEventBundle
        from .paths import events_path

        abs_src = ctx.active_source_abs()
        if not abs_src:
            return "No active source. The user needs to load one in the AI tab."
        ep = events_path(abs_src)
        if not ep.exists():
            return {
                "status": "needs_scan",
                "message": (
                    "Audio-event detection hasn't been run for this source. "
                    "Propose `propose_run_audio_event_scan` to kick it off."
                ),
            }
        try:
            bundle = AudioEventBundle.model_validate_json(ep.read_text())
        except Exception as e:
            return f"failed to load events: {e}"
        kinds_filter = set(args.get("kinds") or [])
        min_conf = float(args.get("min_confidence") or 0.0)
        out_events: list[dict[str, Any]] = []
        for e in bundle.events:
            if kinds_filter and e.kind not in kinds_filter:
                continue
            if e.confidence < min_conf:
                continue
            out_events.append({
                "start": round(e.start, 2),
                "end": round(e.end, 2),
                "kind": e.kind,
                "confidence": round(e.confidence, 2),
            })
        return {
            "status": "ok",
            "events": out_events,
            "total_in_scan": len(bundle.events),
        }

    if name == "get_full_transcript":
        analysis = _load_analysis(ctx)
        if analysis is None:
            return (
                "No analysis available — the user must run Analyze on the "
                "active source first."
            )
        # Condense to one line per segment so Claude can scan a 30-min
        # transcript in a few thousand tokens. Word-level timestamps are
        # still available via `get_transcript_around` when needed.
        segments = []
        for seg in analysis.speech.segments:
            text = " ".join(w.text for w in seg.words).strip()
            if not text:
                continue
            segments.append({
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": text,
            })
        return {
            "duration": round(analysis.speech.duration_seconds, 2),
            "segment_count": len(segments),
            "segments": segments,
        }

    if name == "get_classification_summary":
        if bundle is None:
            return "no classification"
        c = bundle.classification
        return {
            "pause_count": len(bundle.pause_candidates),
            "filler_count": len(bundle.filler_candidates),
            "retake_count": len(c.retakes),
            "pause_actions": {
                "cut": sum(1 for p in c.pauses if p.action == "cut"),
                "trim": sum(1 for p in c.pauses if p.action == "trim"),
                "keep": sum(1 for p in c.pauses if p.action == "keep"),
            },
            "filler_actions": {
                "cut": sum(1 for f in c.fillers if f.action == "cut"),
                "keep": sum(1 for f in c.fillers if f.action == "keep"),
            },
        }

    return f"unknown read tool: {name}"


# ─── Top-level query ─────────────────────────────────────────────────────────


def query(
    *,
    message: str,
    history: list[CadenceMessage],
    project: Project,
    active_source_rel: str | None,
    digest_text: str,
    api_key: str | None = None,
    max_iterations: int = 8,
) -> CadenceResponse:
    """Run one turn of the Cadence conversation.

    Loops on tool use until Claude responds with text only (or we hit the
    iteration cap). Read tools execute server-side and their results are
    fed back to Claude. Action tools are recorded as `ProposedAction`s and
    acked back to Claude so it knows the proposal was accepted.
    """
    from . import keys as keys_mod

    key = api_key or keys_mod.get_key("anthropic")
    if not key:
        raise RuntimeError(
            "Anthropic API key not set. Add it via the Settings panel "
            "in the app, or set ANTHROPIC_API_KEY in .env."
        )

    client = anthropic.Anthropic(api_key=key)
    ctx = CadenceContext(project=project, active_source_rel=active_source_rel)
    actions: list[ProposedAction] = []

    # Build the conversation: prior turns + new user message. We never send
    # action proposals back as part of history (they're handled client-side);
    # only the text content of each turn is preserved.
    messages: list[dict[str, Any]] = []
    for h in history:
        messages.append({"role": h.role, "content": h.text})
    messages.append({"role": "user", "content": message})

    system_blocks = [
        {
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},
        },
        {
            "type": "text",
            "text": f"<project_digest>\n{digest_text}\n</project_digest>",
        },
    ]

    total_in = 0
    total_out = 0
    final_text = ""

    for _ in range(max_iterations):
        resp = client.messages.create(
            model=CADENCE_MODEL,
            max_tokens=4096,
            system=system_blocks,
            tools=ALL_TOOLS,
            messages=messages,
        )
        total_in += getattr(resp.usage, "input_tokens", 0) or 0
        total_out += getattr(resp.usage, "output_tokens", 0) or 0

        # Collect text + tool_use blocks. We append the assistant turn
        # verbatim to messages so the next iteration can reference it.
        assistant_content: list[dict[str, Any]] = []
        tool_uses: list[Any] = []
        text_parts: list[str] = []
        for block in resp.content:
            if block.type == "text":
                text_parts.append(block.text)
                assistant_content.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                tool_uses.append(block)
                assistant_content.append({
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                })
        messages.append({"role": "assistant", "content": assistant_content})

        if resp.stop_reason != "tool_use" or not tool_uses:
            final_text = "\n".join(text_parts).strip()
            break

        # Execute / record each tool call and feed results back.
        tool_results: list[dict[str, Any]] = []
        for tu in tool_uses:
            name = tu.name
            args = tu.input or {}
            if name.startswith("propose_"):
                # Record the proposed action; return a tiny ack so Claude
                # knows it landed.
                actions.append(_make_proposed_action(name, args))
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": json.dumps({"recorded": True, "index": len(actions) - 1}),
                })
            else:
                result = _dispatch_read_tool(name, args, ctx)
                if isinstance(result, str):
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "is_error": True,
                        "content": result,
                    })
                else:
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": json.dumps(result),
                    })
        messages.append({"role": "user", "content": tool_results})

    return CadenceResponse(
        text=final_text or "(no response)",
        actions=actions,
        input_tokens=total_in,
        output_tokens=total_out,
    )


def _make_proposed_action(name: str, args: dict[str, Any]) -> ProposedAction:
    """Translate a `propose_<X>` tool call into a structured ProposedAction
    the frontend can apply via its action dispatcher."""
    summary = args.get("summary", name)
    if name == "propose_run_audio_event_scan":
        return ProposedAction(
            type="run_audio_event_scan",
            summary=summary,
            params={},
        )
    if name == "propose_run_visual_index":
        return ProposedAction(
            type="run_visual_index",
            summary=summary,
            params={},
        )
    if name == "propose_create_highlight_clip":
        return ProposedAction(
            type="add_splice_clip",
            summary=summary,
            params={
                "start": args.get("start"),
                "end": args.get("end"),
                "title": args.get("title", ""),
            },
        )
    if name == "propose_add_custom_cut":
        return ProposedAction(
            type="add_custom_cut",
            summary=summary,
            params={
                "start": args.get("start"),
                "end": args.get("end"),
            },
        )
    if name == "propose_set_override":
        return ProposedAction(
            type="set_override",
            summary=summary,
            params={
                "key": args.get("key"),
                "value": args.get("value"),
            },
        )
    if name == "propose_set_audio_setting":
        return ProposedAction(
            type="set_audio_setting",
            summary=summary,
            params={
                "setting": args.get("setting"),
                "value": args.get("value"),
            },
        )
    # Unknown propose_ tool — surface as opaque so the user can at least see
    # what Claude tried to do.
    return ProposedAction(type=name, summary=summary, params=dict(args))
