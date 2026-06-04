"""Centralized API key storage for the sidecar.

The sidecar reads provider API keys (Anthropic, Groq) from two sources:

1. **In-memory** — set via ``POST /settings/keys`` from the frontend at
   app launch. The Tauri desktop app reads the user's keys from the OS
   keychain and pushes them here on every cold start. Production-mode
   distribution path.

2. **Environment variables** — ``ANTHROPIC_API_KEY`` / ``GROQ_API_KEY``,
   loaded by ``python-dotenv`` from ``.env`` at sidecar startup. Dev path
   for contributors who already have a ``.env`` workflow; also the CI /
   headless path for the CLI subcommands.

In-memory wins when both are set — the assumption being that if the
frontend just pushed a key, the user wants *that* key used. This means a
running sidecar can be re-keyed without restart (e.g. user updates the
Settings modal mid-session and re-renders).

**Never persisted to disk.** Keys live for the lifetime of the sidecar
process. The OS keychain on the Tauri side is the durable store; this
module is just a runtime cache.
"""

from __future__ import annotations

import os
import threading
from typing import Literal

Provider = Literal["anthropic", "groq"]


_LOCK = threading.Lock()
_IN_MEMORY: dict[Provider, str] = {}


def set_key(provider: Provider, value: str | None) -> None:
    """Store an in-memory key. Passing ``None`` or empty string clears it.

    Whitespace is stripped before storage — keychain entries imported from
    other tools (or written by older versions of the app) sometimes carry
    trailing newlines, and SDKs reject those with an opaque 401 rather
    than a clean validation error.

    Thread-safe — the FastAPI sidecar runs request handlers across a
    threadpool and the Cadence query path lazily constructs clients.
    """
    with _LOCK:
        if not value or not value.strip():
            _IN_MEMORY.pop(provider, None)
        else:
            _IN_MEMORY[provider] = value.strip()


_ENV_VARS: dict[Provider, str] = {
    "anthropic": "ANTHROPIC_API_KEY",
    "groq": "GROQ_API_KEY",
}


def get_key(provider: Provider) -> str | None:
    """Return the active key for ``provider`` or ``None`` if neither
    source has one. In-memory wins over the env var.

    The lock is held across both lookups so a concurrent ``set_key`` can't
    race with us — without that, a reader can see an empty in-memory entry,
    release the lock, then read a stale (or absent) env var while the
    writer's new key is already in memory."""
    with _LOCK:
        mem = _IN_MEMORY.get(provider)
        if mem:
            return mem
        env = os.getenv(_ENV_VARS[provider], "").strip()
        return env or None


def is_configured(provider: Provider) -> bool:
    return get_key(provider) is not None


def source_of(provider: Provider) -> Literal["in_memory", "env", "unset"]:
    """Where the active key came from — surfaced in the settings UI so the
    user can tell whether their typed-in key or their ``.env`` is winning.
    Same lock-held semantics as ``get_key`` so the two stay consistent."""
    with _LOCK:
        if provider in _IN_MEMORY:
            return "in_memory"
        if os.getenv(_ENV_VARS[provider], "").strip():
            return "env"
        return "unset"
