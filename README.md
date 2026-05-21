# AI Video Editor

A Python pipeline for auto-editing OBS-recorded YouTube videos. The first stage
(this scaffold) handles **ingest** and **speech analysis** — probing the source,
extracting the mic-only audio track, and producing word-level transcripts plus
Silero VAD speech regions. Downstream stages (pause classification, cut planning,
render) plug into the JSON bundle this stage writes.

## Status

- ✅ Stage 1 — ingest (probe + mic-track extraction + 16 kHz mono normalization)
- ✅ Stage 2 — speech analysis (Silero VAD + Whisper word timestamps, Groq backend)
- ✅ Stage 3 — pause / filler / retake classification (Claude Opus 4.7)
- ✅ Stage 4 — cut planner (interval algebra → edit decision list)
- ✅ Stage 5 — renderer (FFmpeg, libx264 + AAC, per-segment audio fades)
- ✅ Stage 6 — review UI (per-cut audio playback, accept/reject, re-plan)

## Prereqs

- macOS with Homebrew
- `brew install ffmpeg uv`

## Setup

```sh
uv sync
cp .env.example .env
# then edit .env and paste your GROQ_API_KEY
```

That creates `.venv/` and installs everything in `pyproject.toml`.

### API keys

The default pipeline uses two hosted APIs:

- **Groq** for transcription (whisper-large-v3 at ~30× realtime)
- **Anthropic** for pause classification (Claude Opus 4.7)

Copy `.env.example` to `.env` and fill in both keys. Expected per-video cost
at default settings is well under a dollar (Groq ~$0.05, Claude ~$0.50–$1).

### Transcription backends

Two backends are available; pick at runtime via `--backend` or the UI dropdown.

- **`groq` (default)** — uploads audio to Groq's hosted `whisper-large-v3`
  endpoint. ~30× realtime, same model weights as local. Requires
  `GROQ_API_KEY` (get one at <https://console.groq.com/keys>). 25 MB upload
  limit — we transcode to FLAC first, so this comfortably covers ~50 min of
  speech per video.
- **`local`** — runs faster-whisper on Apple Silicon CPU. Slow (~5–10× slower
  than realtime for `large-v3`) but fully offline. The first `local` run
  downloads the model (~3 GB) into the HuggingFace cache.

## Usage

### Option A — UI (recommended)

```sh
uv run video-editor ui
```

Opens a Streamlit app at <http://localhost:8501> with three steps:

1. **Source** — drop a file in the uploader, or paste a path on disk (use the
   path tab for large OBS recordings; the uploader allows up to 4 GB but path
   is faster).
2. **Probe** — auto-runs on selection; shows duration, resolution, fps, VFR
   flag, and the full audio-track table. Use this to identify the mic track.
3. **Analyze** — pick the mic track, Whisper model, and compute precision, then
   run. Results show language, segment/word/VAD counts, an expandable
   transcript with per-word timestamps, the VAD region table, and a download
   button for the JSON bundle.

### Option B — CLI

#### 1. Probe a source video

OBS recordings often have multiple audio tracks (mic + desktop audio on separate
streams). Use `probe` to see which track is which:

```sh
uv run video-editor probe path/to/recording.mov
```

You'll get a table of audio tracks with index, codec, sample rate, and (if OBS
labeled them) titles. Pick the index of the mic track for the next step.

#### 2. Analyze

```sh
uv run video-editor analyze path/to/recording.mov --mic-track 0
```

#### 3. Classify pauses / fillers / retakes (stage 3)

```sh
uv run video-editor classify path/to/recording.analysis.json
```

Sends the transcript + per-word timestamps to Claude Opus 4.7 with a frozen
classification rubric. Output: `recording.classified.json` containing per-pause
category + action + reason, per-filler-candidate cut/keep, and detected retakes
(speaker repeated themselves). Requires `ANTHROPIC_API_KEY` in `.env`.

Useful flags:
- `--min-pause-ms 250` (default) — gaps below this aren't classified
- `--out path/file.json` — override output location

#### 4. Build the cut plan (stage 4)

```sh
uv run video-editor plan path/to/recording.analysis.json
```

Pure interval algebra — no API calls, no network, no video touched. Reads the
analysis JSON + the matching `.classified.json` (auto-discovered alongside) and
produces `recording.plan.json` containing:

- **`keeps`**: ordered list of source-video time ranges that survive editing
- **`cuts`**: audit log of every classifier-driven cut (kind + reason)
- **`params`**: the crossfade / breath / pad values used
- summary stats (source duration, output duration, time saved)

The plan is the contract for the renderer (stage 5).

Useful flags:
- `--crossfade-ms 20` — audio crossfade at every cut boundary
- `--filler-pad-ms 20` — buffer around each filler cut (Whisper jitter)
- `--default-breath-ms 150` — breath trim when classifier didn't specify
- `--min-keep-ms 80` — drop sliver keeps shorter than this

#### 5. Review & refine (stage 6, UI only)

The Streamlit UI has a **Review & refine** section between *Plan results* and
*Render*. For each classifier decision, listen to a ~3-second mic clip around
the cut, override the action with one click, then **Apply changes** to
re-plan. The render section picks up the refined plan automatically.

- Filters: pauses only / fillers only / retakes only / my overrides only / everything
- Per-row audio playback (cached, fast on revisit)
- 20 rows per page with prev/next
- Pending-overrides counter + reset button
- Live preview of how the override set would change the output duration

This step is optional. If the classifier got everything right, skip straight
from Plan to Render.

#### 6. Render the MP4 (stage 5)

```sh
uv run video-editor render path/to/recording.analysis.json
```

Reads the plan JSON alongside, plus the source video path from the analysis,
and produces `recording.edited.mp4` — libx264 + AAC with per-segment audio
fade-in/out at every cut for click-free joins.

Useful flags:
- `--crf 18` (default) — libx264 quality. Lower = better (14–17 archival,
  18–20 near-lossless, 23 YouTube-default-ish)
- `--preset slow` (default) — quality/speed tradeoff: `ultrafast` → `veryslow`
- `--audio-bitrate 192k`
- `--audio-track N` — override which audio track to render (defaults to the
  mic track picked at ingest time)
- `--source PATH` — override source if it's moved
- `--out PATH` — output location

Writes a structured JSON bundle (`recording.analysis.json`) containing:

- the source probe (codecs, resolution, fps, VFR flag, all audio tracks)
- the path to the normalized mic WAV
- Silero VAD speech regions
- Whisper segments with per-word timestamps and confidence

Useful flags:

- `--model large-v3` (default) | `medium` | `small` — trade speed for accuracy
- `--compute-type int8` (default, Apple Silicon friendly) | `float16` | `float32`
- `--language en` to skip auto-detect when you know the language
- `--out custom/path.json` to control output location

## Design notes

- The mic track is extracted alone for analysis — desktop audio would mask
  speech pauses, which is the whole point.
- VAD and transcription are kept independent: Silero gives precise speech
  boundaries; Whisper gives words. The cut planner (next stage) uses both.
- The JSON bundle is the contract between stages. Anything downstream — pause
  classifier, cut planner, renderer, review UI — reads this file and nothing else.

## Layout

```
src/video_editor/
├── cli.py        # typer CLI: probe / analyze / classify / plan / render / ui
├── ui.py         # streamlit app (10 sections, full pipeline + review)
├── ingest.py     # ffprobe + ffmpeg extraction
├── speech.py     # Silero VAD + transcription dispatch
├── backends.py   # groq + local (faster-whisper) transcription backends
├── classifier.py # pause / filler / retake classifier (Claude Opus 4.7)
├── planner.py    # interval algebra → CutPlan (no API, no video)
├── renderer.py   # FFmpeg filter_complex (trim + concat + fades) → MP4
├── reviewer.py   # apply_overrides() + per-cut audio clip extraction
├── models.py     # pydantic data models (JSON contract)
└── __init__.py
```
