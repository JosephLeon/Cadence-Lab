# AI Video Editor

A Python pipeline for auto-editing OBS-recorded YouTube videos. The first stage
(this scaffold) handles **ingest** and **speech analysis** — probing the source,
extracting the mic-only audio track, and producing word-level transcripts plus
Silero VAD speech regions. Downstream stages (pause classification, cut planning,
render) plug into the JSON bundle this stage writes.

## Status

- ✅ Stage 1 — ingest (probe + mic-track extraction + 16 kHz mono normalization)
- ✅ Stage 2 — speech analysis (Silero VAD + faster-whisper word timestamps)
- ⏳ Stage 3 — pause classification (LLM semantic pass)
- ⏳ Stage 4 — cut planner (snap to screen-change zones, breath handling, crossfades)
- ⏳ Stage 5 — renderer (FFmpeg, stream-copy where possible)
- ⏳ Stage 6 — review UI

## Prereqs

- macOS with Homebrew
- `brew install ffmpeg uv`

## Setup

```sh
uv sync
```

That creates `.venv/` and installs everything in `pyproject.toml`. The first run
of `analyze` will download the Whisper `large-v3` model (~3 GB) into the local
HuggingFace cache.

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
├── cli.py        # typer CLI: `probe`, `analyze`, `ui`
├── ui.py         # streamlit app
├── ingest.py     # ffprobe + ffmpeg extraction
├── speech.py     # Silero VAD + faster-whisper
├── models.py     # pydantic data models (JSON contract)
└── __init__.py
```
