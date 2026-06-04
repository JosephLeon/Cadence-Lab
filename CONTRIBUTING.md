# Contributing to Cadence Lab

Thanks for the interest. This is a personal portfolio project but
contributions are welcome — especially around:

- Classifier prompt tuning (`src/cadence_lab/classifier.py`)
- Ask Cadence tool design (`src/cadence_lab/cadence.py`)
- Windows / Linux platform support (currently macOS-tested)
- Hardware encoder detection beyond `h264_videotoolbox`
  (`h264_nvenc`, `h264_qsv`, `h264_amf`)
- Test coverage for modules that don't have it yet

## Before you open a PR

**For non-trivial changes, open an issue first.** Briefly describe what
you want to change and why. Cheaper than discovering after a 500-line PR
that we'd rather solve it differently.

For typo fixes, small bugs, or doc tweaks, just open the PR directly.

## Development setup

Requirements: macOS or Linux, Python 3.11+, `ffmpeg`, `uv`, Bun, and the
Rust toolchain (for the Tauri shell).

```sh
brew install ffmpeg uv bun rustup-init && rustup-init -y
```

Then:

```sh
git clone https://github.com/JosephLeon/Cadence-Lab.git
cd Cadence-Lab

uv sync                                  # Python sidecar + pipeline
cp .env.example .env                     # add GROQ + ANTHROPIC keys

cd app && bun install && cd ..           # Frontend deps

# Run the full desktop app — Tauri shell + Vite dev server + sidecar
cd app && bun tauri:dev
```

For frontend-only iteration without Tauri:

```sh
# Terminal 1
uv run cadence-lab server

# Terminal 2
cd app && bun dev    # then open http://localhost:1420
```

## Running tests

```sh
uv run pytest                            # backend: planner, reviewer, paths, projects
cd app && bun run tsc --noEmit           # frontend: TypeScript typecheck
```

The test suite covers the pure-logic modules (interval algebra, override
application, filename schema, manifest serdes). LLM calls, end-to-end
rendering, and frontend components are deliberately not tested — they're
either expensive to mock meaningfully (LLM) or covered by manual smoke
tests in the desktop app (rendering, UI).

If you add a new pure-logic module, please add a test file under `tests/`.
The existing files show the shape — fixtures live in `tests/conftest.py`.

## What I care about in PRs

- **Tests for new pure-logic helpers** — anything that takes structured
  input and returns structured output without side effects deserves a
  smoke test.
- **Type hints everywhere.** Python is fully typed (`from __future__ import
  annotations`), frontend is strict TypeScript. Keep both that way.
- **Pydantic for new data models.** The JSON contracts between stages are
  the load-bearing structure — they're all Pydantic. Don't introduce
  dataclasses or plain dicts for things crossing stage boundaries.
- **Comments explain *why*, not *what*.** Code already says what.
- **Small, focused PRs over big ones.** Easier to review.
- **No new dependencies without a reason.** Especially heavy ML deps —
  the install size is already substantial.

## What's out of scope

- **Premiere / DaVinci / Final Cut plugins.** Possibly worth doing, but
  not in this repo.
- **Multi-user / cloud-hosted deployments.** Cadence Lab is a local
  desktop tool; the sidecar binds to `127.0.0.1` only and has no auth.
  Hosting it requires re-thinking authentication, request isolation, and
  artifact ownership — outside the scope here.
- **The legacy Streamlit UI.** Being phased out in favor of the Tauri
  desktop app. Fixes that keep it limping along are fine; new feature
  work should target the Tauri/React frontend.

## Reporting bugs

Open an issue with:
- What you ran (command + flags, or the UI flow)
- What you expected
- What actually happened (stderr / stack trace / produced JSON)
- A short audio/video snippet that reproduces it, if applicable and you
  can share it

## License

By contributing you agree your contributions are licensed under the same
MIT license as the project ([LICENSE](LICENSE)).
