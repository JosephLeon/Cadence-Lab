# Architecture

The Cadence Lab desktop app is being built as a **Tauri shell + React frontend
+ FastAPI Python sidecar**. This doc captures *why* it's structured that way
and *what each layer owns*, so anyone (including future-me) can pick up the
project and not relitigate decisions.

## High-level shape

```
┌─────────────────────────────────────────────────────┐
│  Tauri shell (native window, ~10 MB Rust binary)    │
│  - menus, dock icon, installer, file dialogs        │
│  - spawns sidecar, lifecycle, kills on quit         │
│  ┌───────────────────────────────────────────────┐  │
│  │  React frontend (webview)  app/ or frontend/  │  │
│  │  - editor UI (3-pane: media / canvas / timeline) │
│  │  - state, drag interactions, keyboard shortcuts  │
│  │  - talks to sidecar via fetch + SSE              │
│  └────────────┬──────────────────────────────────┘  │
│               │ HTTP + SSE on localhost:27182       │
│               ▼                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  FastAPI sidecar (src/cadence_lab/server.py)  │  │
│  │  - thin layer over the existing pipeline      │  │
│  │  - sync endpoints for fast ops                │  │
│  │  - async job-based endpoints for slow ops     │  │
│  │  - SSE stream for progress                    │  │
│  └────────────┬──────────────────────────────────┘  │
│               │ direct function calls               │
│               ▼                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  Pipeline (src/cadence_lab/{ingest,speech,    │  │
│  │  classifier,planner,renderer,reviewer}.py)    │  │
│  │  unchanged from CLI / Streamlit days          │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## Why this shape

### Why Tauri over Electron

- **Bundle size:** ~10 MB Rust shell vs Electron's ~120 MB Chromium copy
- **Performance:** uses the OS-native webview (WKWebView on macOS), no shipped Chrome
- **Per-app overhead:** lower memory, fewer processes
- **Sidecar story:** Tauri has first-class support for spawning bundled binaries
  (which is exactly what we need for the Python pipeline)
- **Portfolio narrative:** Rust shell + Python pipeline + React UI is a stronger
  full-stack story than Electron + Python + React

The downside (smaller library ecosystem than Electron) doesn't matter here —
all the video-editor primitives we need (wavesurfer.js, react-rnd, video.js,
react-query, zustand) work in any browser webview regardless of shell.

### Why a Python sidecar over rewriting the pipeline

The pipeline is ~2,000 LOC of *thoughtful* Python: structured outputs with
prompt caching, Claude Opus 4.7 with adaptive thinking, Silero VAD, Whisper,
FFmpeg filter graphs. Rewriting it in TypeScript or Rust would take weeks and
add zero value — none of the speed-sensitive bits are written in Python
(ffmpeg subprocess, Groq API, Claude API are all elsewhere). The sidecar
pattern lets us keep the brain in Python without forcing the frontend to be
Python too.

### Why HTTP + SSE over native IPC or WebSockets

- **HTTP** is universal. Any frontend (Tauri webview, regular browser, curl,
  the OpenAPI Swagger UI at `/docs`) can talk to the server. Lets us debug
  with `curl` and run the same backend behind a future web frontend if we
  ever want one.
- **SSE** for streaming progress. One-way (server → client), built into
  browsers (`EventSource`), auto-reconnects, no extra framing logic. The
  alternative — WebSockets — would force async-context complexity for what
  is fundamentally a "give me updates on this long-running job" use case.
- **Native Tauri IPC** would couple the frontend to Tauri (no browser fallback)
  and offer no real wins for the speed of operations we care about.

### Why threads, not asyncio, for the work

All the pipeline stages are sync code that calls into native libraries
(faster-whisper, Silero VAD via PyTorch, ffmpeg subprocesses, Groq SDK,
Anthropic SDK). Trying to await them would mean running them in a threadpool
anyway. We use `ThreadPoolExecutor(max_workers=2)` directly — limit of 2
because two ffmpeg encodes at once would thrash a single machine.

## Backend (FastAPI sidecar)

**File:** [`src/cadence_lab/server.py`](../src/cadence_lab/server.py)

**Launch:**

```sh
uv run cadence-lab server         # default: 127.0.0.1:27182
uv run cadence-lab server --reload  # dev: hot reload on code change
```

**Endpoint categories:**

| Kind | Endpoints | Returns |
|---|---|---|
| Sync — fast | `GET /health`, `POST /probe`, `POST /plan`, `POST /apply-overrides` | Result body directly |
| Async — slow | `POST /analyze`, `POST /classify`, `POST /render` | `{job_id}` immediately |
| Job introspection | `GET /jobs/{id}`, `GET /jobs/{id}/events` (SSE) | Current state / event stream |
| Media | `GET /files/{name}`, `GET /audio-clip?audio_path=…&start=…&end=…` | Binary (MP4 / MP3 / WAV) |
| Bundle reads | `GET /analysis`, `GET /classification`, `GET /plan-bundle` | Pydantic bundles |

**Job lifecycle:**

1. `POST /analyze` (or `/classify`, `/render`) returns `{job_id: "..."}`.
2. Frontend either polls `GET /jobs/{id}` periodically or opens an SSE
   connection to `GET /jobs/{id}/events`.
3. SSE events come as `{progress: 0..1, message: str}` JSON, with a final
   `{_terminal: true, status: "done"|"error"}` event when the job ends.
4. Job result is in `GET /jobs/{id}.result` once `status == "done"`.

Jobs live in an in-memory dict (`_jobs`) keyed by UUID. Acceptable for a
desktop single-user app; would need Redis/DB for multi-user SaaS.

**API docs:** auto-generated at `http://localhost:27182/docs` (Swagger UI) and
`/redoc`. Hit those during development to explore the schema interactively.

## Frontend (to be built — Phase 2)

**Stack target:**

- **Vite + React + TypeScript** for the build/dev tooling
- **Tailwind CSS + shadcn/ui** for styling and base components
- **Zustand** for state (lighter than Redux, no boilerplate)
- **TanStack Query** for server state (the FastAPI sidecar's responses)
- **wavesurfer.js** for waveform display in the timeline
- **react-rnd** or **interact.js** for draggable/resizable timeline clips
- **EventSource** (built-in) for SSE subscription

**Three-pane layout target:**

```
┌──────────────────────────────────────────────────────────────┐
│  Top bar: project name, undo/redo, export, command bar       │
├──────────┬─────────────────────────────────────────┬─────────┤
│  Media   │                                         │  AI /   │
│  browser │       Canvas (video player)             │  layer  │
│          │                                         │  panel  │
├──────────┴─────────────────────────────────────────┴─────────┤
│  Timeline (multi-track, scrubbable, drag-trim)               │
└──────────────────────────────────────────────────────────────┘
```

Path the frontend will live in: `app/` (alongside `src/cadence_lab/`).
Decision deferred: Vite + React-Router vs Next.js. Vite is the simpler choice
for a desktop-bundled app where SSR/routing aren't load-bearing.

## Tauri wrapper (Phase 7 — landed)

The Tauri Rust shell lives in `app/src-tauri/`. Its responsibilities:

1. Spawn the FastAPI sidecar (`uv run cadence-lab server`) on app launch
   from a `setup` hook. Walks up from the binary's executable path to find
   `pyproject.toml` and runs `uv` in that directory.
2. Manage the `Child` handle in app state (`SidecarHandle(Mutex<Option<Child>>)`).
3. On `RunEvent::ExitRequested` / `Exit`, take the handle, kill the process,
   and wait — so closing the app stops the backend too (no orphans).
4. Show the React UI inside a native WKWebView on macOS.

Code: [`app/src-tauri/src/lib.rs`](../app/src-tauri/src/lib.rs).

### Dev vs production sidecar bundling — current state

| Mode | How the sidecar runs | Status |
|---|---|---|
| `tauri dev` | Rust shell spawns `uv run cadence-lab server` from the workspace root | ✅ working — used today |
| `tauri build` (.dmg) | Same spawn, requires `uv` + `cadence-lab` installed on the user's machine | ⚠ works but user-dependent |
| Fully self-contained `.dmg` | PyInstaller-frozen sidecar binary, bundled as a Tauri `externalBin` and shipped inside the .app | ⏳ deferred |

The deferred work — full self-contained bundle — needs:

- **PyInstaller (or Nuitka) to freeze the Python sidecar** to a single binary.
  Will need careful handling of native deps with non-trivial loaders:
  faster-whisper (uses ctranslate2 with bundled .so/.dll), silero-vad
  (PyTorch + ONNX), soundfile (libsndfile), the ffmpeg subprocess (need to
  bundle a static ffmpeg too, or document that the user installs it).
- **Tauri externalBin configuration** to embed the frozen binary at a known
  relative path inside the bundle.
- **Update spawn_sidecar() in lib.rs** to find the bundled binary via
  `app_handle.path().resource_dir()` instead of `uv run`.
- **Code signing + notarization** if shipping to non-developer users.

Not blocking for current development use. Today the workflow is "I install
the Python package via `uv sync` once, then `bun tauri dev` gives me a
working desktop app." That's enough to keep building features against.

## Repository layout (current and projected)

```
cadence-lab/
├── src/cadence_lab/                    # Python pipeline + FastAPI sidecar
│   ├── server.py                       # ✅ FastAPI sidecar (REST + SSE)
│   ├── paths.py                        # ✅ output dir + per-stage path helpers
│   ├── ingest.py                       # ✅ pipeline stages
│   ├── speech.py
│   ├── classifier.py
│   ├── planner.py
│   ├── renderer.py
│   ├── reviewer.py
│   ├── ui.py                           # ⚠️ legacy Streamlit — being phased out
│   ├── cli.py                          # ✅ + `server`, `migrate` subcommands
│   └── ...
├── app/                                # ✅ Frontend + Tauri shell
│   ├── src/                            # ✅ React + TypeScript
│   │   ├── components/                 # TopBar, MediaBrowser, Canvas, Timeline, RightPanel, ReviewPanel
│   │   ├── hooks/                      # usePipeline, useKeyboardShortcuts
│   │   ├── stores/                     # project, videoRef, planCache
│   │   ├── api/                        # typed FastAPI client
│   │   └── ...
│   ├── src-tauri/                      # ✅ Tauri Rust shell
│   │   ├── src/lib.rs                  # sidecar spawn + lifecycle
│   │   ├── Cargo.toml
│   │   └── tauri.conf.json
│   ├── vite.config.ts
│   └── package.json
├── pyproject.toml
└── docs/
    └── ARCHITECTURE.md                 # this file
```

## Decision log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-21 | Replace Streamlit UI with native desktop app | Streamlit can't deliver the multi-pane editor experience the project needs |
| 2026-05-21 | Tauri over Electron | Bundle size, performance, sidecar support, narrative |
| 2026-05-21 | FastAPI Python sidecar over rewrite | Pipeline is 2K lines of careful work; rewriting buys nothing |
| 2026-05-21 | HTTP + SSE over native IPC / WebSockets | Universal, debuggable, simpler semantics for our use case |
| 2026-05-21 | Threads (not asyncio) for the work | Pipeline stages are sync; awaiting would just trampoline through a threadpool anyway |
| 2026-05-21 | Vite + React + TypeScript for frontend | Standard, fast, well-supported in webviews |
| 2026-05-21 | Keep Streamlit UI alive during transition | Lets us dogfood the pipeline while building the real frontend |

## Open questions (for Phase 2+)

- **Static or hosted frontend in Tauri?** Production should ship a bundled
  static React build. Dev mode should load Vite's dev server URL.
- **Sidecar bundling strategy?** PyInstaller (heavy, self-contained) vs
  requiring users to have `uv` (lightweight, requires Python on user's
  machine). Likely PyInstaller for shipped binaries, `uv` for development.
- **Auto-update?** Tauri has an updater plugin. Worth wiring up before
  shipping any v1.
- **Code signing?** $99/yr Apple developer account for Mac. Windows
  certificates are ~$200/yr. Or ship unsigned and tell users to dismiss
  warnings.
- **Where to store project state?** SQLite in `~/Library/Application Support/Cadence Lab/`
  for project list, recent files, settings.
