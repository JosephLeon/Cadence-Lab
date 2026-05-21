# Cadence Lab

**An AI-driven semantic video editor for YouTube creators.** Drop in an OBS
recording; Cadence Lab transcribes it with Whisper, asks Claude Opus 4.7 to
classify every pause and filler word *in context* (not by amplitude), plans
the cuts as pure interval algebra, lets you review them with per-cut audio
playback, and renders a YouTube-ready MP4 with hardware-accelerated FFmpeg.

Built because every "auto-edit silence" tool I tried was a regex over the
waveform. This one actually thinks about each pause.

> 🎬 _Demo GIF / screenshot goes here — record once the UI is polished_

---

## Why this exists (and why it might interest you)

Most automatic video editors are amplitude thresholders: anything quieter than
−30 dB for longer than 0.4 s gets cut. That works for the easy half of the
problem and butchers the other half — it cuts breaths to zero (which sounds
robotic), removes dramatic pauses that were *intentional*, and treats every
"um" the same as every "like." It also can't see retakes: when you flub a
sentence and start over, an amplitude tool keeps both takes; a human editor
keeps the second one.

Cadence Lab is structured as a **6-stage pipeline** where the cut decisions
are made by an LLM that has the full transcript in context. The novel bits
are not in the FFmpeg or the Whisper integration — those are standard. The
interesting parts are:

- **Pause classification as a 7-way decision, not a boolean.** Each gap gets
  labeled `filler` / `hesitation` / `breath` / `emphasis` / `pre_laughter`
  / `transition` / `listening`, each with its own cut behavior. Breaths get
  *trimmed to 150 ms*, not deleted — that's the difference between sounding
  natural and sounding like an AI.
- **Context-aware filler-word judgment.** "Like" used filler-style gets cut;
  "like" used meaningfully ("nothing else *like* it") gets kept. The classifier
  sees the surrounding words to decide.
- **Retake detection.** If the speaker says "let me try that again" or
  re-attempts the same sentence twice, the LLM flags the worse take.
- **Structured outputs via `output_config.format`.** The Claude response is
  constrained by a JSON schema so there's no regex parsing, no possibility of
  malformed output — the cut planner consumes typed Pydantic models directly.
- **Prompt caching on the classifier rubric.** The system prompt is wrapped in
  `cache_control: {"type": "ephemeral"}` so re-running on more videos reads
  the rubric from cache (~0.1× input cost on repeat).
- **Hardware encode by default** (`h264_videotoolbox` on Apple Silicon),
  with libx264 as an opt-in "archival" mode. Renders typically run 5–15×
  faster than libx264 -preset slow for delivery-quality output that YouTube
  re-encodes anyway.
- **Per-classifier-item review UI with inline audio.** Listen to a ~3-second
  clip around each proposed cut, override the classifier with a single click,
  re-plan instantly. Override decisions flow back through `apply_overrides()`
  → `plan_cuts()` so the same code path serves both the initial plan and the
  refined plan.

If you're building LLM-augmented pipelines and want a reference for
production-quality choices around structured outputs, prompt caching, multi-stage
data contracts, and progressive disclosure UI — this is a real working example
of all of those.

---

## Pipeline

```
                                    JSON contracts between stages
                                                ▼
 source.mov  ──►  ┌─────────────┐  ──►  ┌──────────────┐  ──►  ┌────────────────┐
                  │  1. Ingest  │       │ 2. Analyze   │       │ 3. Classify    │
                  │             │       │              │       │                │
                  │ ffprobe +   │       │ Silero VAD + │       │ Claude Opus    │
                  │ mic-track   │       │ Whisper      │       │ 4.7 — pause +  │
                  │ extraction  │       │ (Groq cloud  │       │ filler classes │
                  │             │       │  or local)   │       │ + retakes      │
                  └─────────────┘       └──────────────┘       └────────────────┘
                                                                       │
                  ┌─────────────┐       ┌──────────────┐       ┌──────────────┐
                  │ 6. Review   │ ◄──── │ 5. Render    │ ◄──── │ 4. Plan      │
                  │             │       │              │       │              │
                  │ per-cut     │       │ FFmpeg       │       │ Interval     │
                  │ audio +     │       │ filter_      │       │ algebra:     │
                  │ accept /    │       │ complex      │       │ classifier   │
                  │ reject /    │       │ (HW encode   │       │ output →     │
                  │ re-plan     │       │  by default) │       │ keep-segments│
                  └─────────────┘       └──────────────┘       └──────────────┘
                       ▲                                              │
                       └──────────── re-plan with overrides ◄─────────┘
```

Each stage writes a structured JSON file. The next stage reads it. You can
stop at any stage, edit the JSON by hand if you want, and resume.

```
recording.mov                  ← source
recording.analysis.json        ← stage 2 output: probe + transcript + VAD
recording.classified.json      ← stage 3 output: per-pause/filler classifications
recording.plan.json            ← stage 4 output: keep-segments + audit log
recording.edited.mp4           ← stage 5 output: the final video
```

---

## Quickstart

### Requirements

- macOS (Apple Silicon recommended — hardware video encoder) or Linux
- Python 3.11+
- `ffmpeg` and `uv` on `PATH`

```sh
brew install ffmpeg uv
```

### Setup

```sh
git clone https://github.com/JosephLeon/cadence-lab.git
cd cadence-lab
uv sync
cp .env.example .env       # then add your keys
```

You need two API keys:

- **`GROQ_API_KEY`** — for transcription. Whisper-large-v3 hosted by Groq runs
  at ~30× realtime for ~$0.05 per 30 minutes of audio. Get one at
  <https://console.groq.com/keys>.
- **`ANTHROPIC_API_KEY`** — for Claude Opus 4.7 classification. ~$0.50–$1.50
  per 30-minute video at default settings. Get one at
  <https://console.anthropic.com/settings/keys>.

### Launch

```sh
uv run cadence-lab ui
```

Opens at <http://localhost:8501>. Drop a video in, walk through sections 1–11.
Already have JSON artifacts from a previous run? Use the **"Resume from JSON"**
tab in section 1 to skip straight to the stage you left off at.

### Or use the CLI

Each stage is a separate subcommand; they're chained by JSON output.

```sh
uv run cadence-lab probe   recording.mov                    # list audio tracks
uv run cadence-lab analyze recording.mov                    # → analysis.json
uv run cadence-lab classify recording.analysis.json         # → classified.json
uv run cadence-lab plan    recording.analysis.json          # → plan.json
uv run cadence-lab render  recording.analysis.json          # → edited.mp4
```

The `render` command uses hardware encoding by default on Apple Silicon
(`h264_videotoolbox`, ~5–15× faster than libx264 with quality YouTube can't
distinguish after its own re-encode). Pass `--encoder libx264` for an
archival CPU encode at `-preset slow -crf 18`.

---

## Architecture deep-dive

### Stage 1 — Ingest ([`ingest.py`](src/cadence_lab/ingest.py))

Probes the source with `ffprobe`, detects variable frame rate, and extracts
the mic track alone as 16 kHz mono PCM WAV. **Mic-only matters:** OBS records
mic and desktop audio on separate tracks; if the analyzer sees desktop audio,
game sounds or background music will mask the speech pauses we're trying to
classify.

### Stage 2 — Speech analysis ([`speech.py`](src/cadence_lab/speech.py) + [`backends.py`](src/cadence_lab/backends.py))

Two parallel signals on the mic WAV:

- **Silero VAD** produces frame-accurate "speech vs not" boundaries. Used by
  later stages to know exactly where words begin and end — independent of
  what the transcriber thinks was said.
- **Whisper large-v3** produces the transcript with per-word timestamps. The
  default backend is **Groq** (hosted, ~30× realtime, ~$0.05/video); the
  local backend is faster-whisper on CPU as a fallback.

The Groq path transcodes the mic WAV to Opus 64 kbps before upload
(lossless-for-Whisper, ~5× smaller than FLAC). For audio that exceeds Groq's
25 MB upload limit, it splits at silence boundaries detected by `ffmpeg
silencedetect`, transcribes each chunk independently, and stitches the
timestamps back together.

### Stage 3 — Classification ([`classifier.py`](src/cadence_lab/classifier.py))

This is the LLM bit. The pre-processor:
1. Computes every word-to-word gap ≥ 250 ms (assigns each a stable ID).
2. Scans the transcript for candidate filler tokens (`um`, `uh`, `like`,
   `actually`, etc., each with a stable ID).
3. Builds an annotated transcript where pauses and filler candidates are
   marked inline:
   ```
   [00:00] Hello «P:0 (0.52s)» everyone «F:0:"um"» welcome to the show.
   ```

Then a single call to Claude Opus 4.7 with:
- `thinking: {"type": "adaptive"}` + `effort: "high"` — the classifier
  benefits from reasoning across the full transcript
- `output_config: {format: {type: "json_schema", schema: ...}}` — Claude is
  constrained to produce JSON matching our schema; no regex, no parsing
  fragility
- `cache_control: {"type": "ephemeral"}` on the system prompt with the
  classification rubric — subsequent videos read the rubric from cache

The output is per-pause `{category, action, reason}`, per-filler
`{action, reason}`, plus detected retakes.

### Stage 4 — Cut planner ([`planner.py`](src/cadence_lab/planner.py))

**Pure interval algebra, no API, no video touched.** Each classifier "cut" or
"trim" decision contributes one or more removal intervals; the planner merges
overlapping intervals, takes the complement in `[0, duration]` to get
keep-segments, drops slivers shorter than `min_keep_ms`. The original cut-op
list is preserved as an audit log so the review UI can show the *original
intent* even after merging (e.g. a retake that swallowed three filler cuts
within it).

### Stage 5 — Renderer ([`renderer.py`](src/cadence_lab/renderer.py))

FFmpeg `filter_complex` building one trim per keep-segment for video and one
trim+fade-in+fade-out per keep-segment for audio. Per-segment fades (rather
than `acrossfade`) avoid the time offset `acrossfade` introduces, so video
and audio stay frame-aligned without any sync correction. The whole filter
graph is written to a temp file via `-filter_complex_script` to avoid
command-line length limits with hundreds of cuts.

Encoder defaults: **`h264_videotoolbox`** if available (Apple Silicon hardware
encoder) at `-q:v 65 -realtime 0 -prio_speed 0 -profile:v high`, else falls
back to libx264. Pass `encoder="libx264"` explicitly to force the slow CPU
encode for an archival master.

### Stage 6 — Review UI ([`reviewer.py`](src/cadence_lab/reviewer.py) + Streamlit section 9)

For each classifier decision, a row with:
- Timestamp + duration
- Transcript context (`±6` words around the cut)
- Inline MP3 clip extracted lazily from the mic WAV (cached)
- Radio buttons for the override action

User overrides are stored as `{(kind, source_id): override_value}` in
session state. Clicking "Apply changes" runs `apply_overrides()` on the
classification, then `plan_cuts()` on the modified version — pure functional
flow, no mutation of the original artifacts.

---

## Cost per video

At default settings, end-to-end for a 30-minute source video:

| Stage | What | Cost |
|---|---|---|
| 2 — Transcription | Groq whisper-large-v3 | ~$0.05 |
| 3 — Classification | Claude Opus 4.7, ~25 K input + ~10 K output tokens | $0.50–$1.50 |
| 4 — Planning | Local CPU | $0 |
| 5 — Render | Local CPU/GPU | $0 |
| **Total** | | **~$0.55–$1.55** |

The local backend (`faster-whisper`) is offline + free but ~5–10× slower than
Groq; useful if you don't want audio leaving your machine.

---

## Project layout

```
src/cadence_lab/
├── cli.py        # typer CLI: probe / analyze / classify / plan / render / ui
├── ui.py         # streamlit app (11 sections, full pipeline + review)
├── ingest.py     # ffprobe + ffmpeg mic-track extraction
├── speech.py     # Silero VAD + transcription dispatch
├── backends.py   # Groq + local (faster-whisper) backends, with chunking
├── classifier.py # pause / filler / retake classifier (Claude Opus 4.7)
├── planner.py    # interval algebra → CutPlan (no API, no video)
├── renderer.py   # FFmpeg filter_complex (videotoolbox or libx264)
├── reviewer.py   # apply_overrides() + per-cut audio clip extraction
├── models.py     # pydantic data models (the JSON contract)
└── __init__.py
```

---

## What's deferred (and why)

A few things in the original architecture sketch that I haven't built:

- **Screen-change snapping.** The plan was: sample frames every ~250 ms,
  detect "screen change moments" via perceptual hash, snap each keep-segment
  boundary to the nearest one within ±500 ms so cuts feel intentional. Worth
  doing for screen-recording content. Currently cuts land on word-aligned
  positions which is already pretty clean.
- **Style-profile aggregation.** The review UI's accept/reject decisions die
  with the session today. The architecture called for these to feed a
  per-channel style profile over time. Useful once you've reviewed enough
  videos to have a feel for what patterns to learn.
- **Stream-copy where possible.** The original spec said "stream-copy
  untouched regions, re-encode only across cut boundaries." With hardware
  encode by default, the speedup isn't worth the complexity.
- **Bulk operations in review.** Currently you reject cuts one at a time.
  "Reject all filler cuts under 400 ms" type operations would be useful once
  you have 200+ cuts to review.

---

## Tech stack

- **Python 3.11+**, [`uv`](https://github.com/astral-sh/uv) for dependencies
- **[Anthropic SDK](https://github.com/anthropics/anthropic-sdk-python)** — Claude Opus 4.7
  with adaptive thinking, structured outputs via `output_config.format`,
  prompt caching
- **[Groq SDK](https://github.com/groq/groq-python)** — hosted whisper-large-v3
- **[faster-whisper](https://github.com/SYSTRAN/faster-whisper)** — local fallback transcription
- **[silero-vad](https://github.com/snakers4/silero-vad)** — voice activity detection
- **[FFmpeg](https://ffmpeg.org/)** — all media manipulation; `h264_videotoolbox` or `libx264`
- **[Pydantic](https://docs.pydantic.dev/)** v2 — typed data models for the JSON contracts
- **[Typer](https://typer.tiangolo.com/)** — CLI
- **[Streamlit](https://streamlit.io/)** — admin / review UI (custom dark theme + CSS polish)

---

## License

[MIT](LICENSE). Use it for whatever you want — personal, commercial,
remixing, training your own model on its outputs. Attribution appreciated
but not required.

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the short
guidelines.
