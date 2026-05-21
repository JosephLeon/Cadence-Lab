# Contributing to Cadence Lab

Thanks for the interest. This is a small project but I'm happy to take
contributions — especially around classifier prompt tuning, screen-change
snapping (currently deferred), and platform support beyond Apple Silicon.

## Before you open a PR

**For non-trivial changes, open an issue first.** Briefly describe what you
want to change and why. It's much less painful than discovering after a 500-line
PR that I'd rather solve it differently.

For typo fixes, small bug fixes, or doc tweaks, just open the PR directly.

## Development setup

```sh
git clone https://github.com/JosephLeon/cadence-lab.git
cd cadence-lab
brew install ffmpeg uv      # macOS — on Linux, use your distro's ffmpeg
uv sync
cp .env.example .env        # then add your GROQ_API_KEY + ANTHROPIC_API_KEY
uv run cadence-lab ui
```

Python 3.11+, `uv` for dependency management.

## What I care about in PRs

- **Tests for new logic.** If you add a new stage or non-trivial helper, add a
  smoke test (synthetic input → expected output). The existing planner /
  reviewer tests in commits show the pattern.
- **Type hints.** This codebase is fully typed. Keep it that way.
- **Pydantic for new data models.** The JSON contracts between stages are the
  load-bearing structure — they're all Pydantic. Don't introduce dataclasses
  or plain dicts for things crossing stage boundaries.
- **Comments explain *why*, not *what*.** Code already says what.
- **Small, focused PRs over big ones.** Easier to review and reason about.

## What's out of scope

- **GUI improvements to the Streamlit UI** that depart from "minimal admin
  panel" energy. Streamlit isn't the right tool for a polished consumer UI; if
  you want a richer review experience the right answer is a separate
  FastAPI + React frontend, not piling CSS on Streamlit.
- **Premiere / DaVinci / Final Cut plugins.** Possibly worth doing, but not in
  this repo.

## Reporting bugs

Open an issue with:
- What you ran (command + flags)
- What you expected
- What actually happened (stderr / stack trace / produced JSON)
- A short audio/video snippet that reproduces it, if applicable and you can
  share it

## License

By contributing you agree your contributions are licensed under the same MIT
license as the project ([LICENSE](LICENSE)).
