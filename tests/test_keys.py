"""Tests for the keys module — in-memory store with env fallback.

These pin two security-relevant invariants:
- Whitespace is stripped on set (prevents silent 401s from trailing-newline
  keychain entries imported from other tools)
- get_key + source_of agree (status surfaced to UI must match the key the
  next provider call actually uses)
"""

from __future__ import annotations

import pytest

from cadence_lab import keys


@pytest.fixture(autouse=True)
def _clean_in_memory_and_env(monkeypatch: pytest.MonkeyPatch):
    """Wipe in-memory store and env vars before/after each test so order
    doesn't matter and tests don't leak into the running process."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    keys.set_key("anthropic", None)
    keys.set_key("groq", None)
    yield
    keys.set_key("anthropic", None)
    keys.set_key("groq", None)


def test_set_and_get_in_memory():
    keys.set_key("anthropic", "sk-test")
    assert keys.get_key("anthropic") == "sk-test"
    assert keys.source_of("anthropic") == "in_memory"


def test_set_strips_whitespace():
    """Keychain entries imported from other tools sometimes carry trailing
    newlines; the SDK rejects those with an opaque 401. Stripping at the
    storage layer is the simplest fix."""
    keys.set_key("anthropic", "  sk-test\n")
    assert keys.get_key("anthropic") == "sk-test"


def test_whitespace_only_value_clears():
    """A value that is only whitespace should be treated as 'no key'."""
    keys.set_key("anthropic", "sk-real")
    keys.set_key("anthropic", "   \n  ")
    assert keys.get_key("anthropic") is None
    assert keys.source_of("anthropic") == "unset"


def test_empty_string_clears():
    keys.set_key("anthropic", "sk-real")
    keys.set_key("anthropic", "")
    assert keys.get_key("anthropic") is None


def test_none_clears():
    keys.set_key("anthropic", "sk-real")
    keys.set_key("anthropic", None)
    assert keys.get_key("anthropic") is None


def test_env_fallback_when_no_in_memory(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
    assert keys.get_key("anthropic") == "sk-env"
    assert keys.source_of("anthropic") == "env"


def test_in_memory_wins_over_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
    keys.set_key("anthropic", "sk-memory")
    assert keys.get_key("anthropic") == "sk-memory"
    assert keys.source_of("anthropic") == "in_memory"


def test_env_whitespace_is_stripped(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "  sk-env\n")
    assert keys.get_key("anthropic") == "sk-env"


def test_source_of_unset_when_neither_present():
    assert keys.source_of("anthropic") == "unset"
    assert keys.get_key("anthropic") is None


def test_source_of_and_get_agree(monkeypatch: pytest.MonkeyPatch):
    """source_of must match where get_key would actually read from —
    UI status would otherwise lie about which key the provider call uses."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
    # env only
    assert keys.source_of("anthropic") == "env"
    assert keys.get_key("anthropic") == "sk-env"
    # in_memory overrides
    keys.set_key("anthropic", "sk-mem")
    assert keys.source_of("anthropic") == "in_memory"
    assert keys.get_key("anthropic") == "sk-mem"
    # in_memory cleared → falls back to env
    keys.set_key("anthropic", None)
    assert keys.source_of("anthropic") == "env"
    assert keys.get_key("anthropic") == "sk-env"
