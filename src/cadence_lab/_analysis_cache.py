"""Content-hash cache for analysis artifacts.

Reanalyzing a source video is expensive: Groq Whisper transcription is the
biggest line item per video at default settings. But the inputs to that pass
are deterministic functions of the *audio stream* (we extract a 16 kHz mono
mic-only WAV, then run Whisper on it). If the bytes of the extracted mic
WAV are the same, the resulting transcript will be too.

So we keep a content-addressed cache keyed by the SHA256 of the extracted
mic WAV. ``ingest`` runs first and produces that WAV anyway; we hash its
bytes (cheap, ~1s for a 30-min recording) and look up a cached analysis
before paying for transcription.

Cache shape::

    <cache_dir>/analysis_by_hash/
      <hash>.json    # the speech-side of AnalysisBundle, with audio_path
                     # left as a placeholder that gets rewritten on restore

When ``/analyze`` runs, we hash the new source's extracted mic WAV. If a
cache file exists, we restore the cached speech object, rewrite paths to
point at the current source, and skip Whisper. Cache miss falls through
to the normal pipeline and writes a new cache entry on success.

This catches:
- Re-importing the same file (different filename, same bytes)
- Copying a source between projects
- Re-running analyze on the same file after a project move
- Symlinked / hard-linked duplicates

It does NOT catch trims, edits, or different mic-track selections, since
those produce different audio bytes and will hash differently. That's the
correct behavior.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .paths import cache_dir


def _cache_dir() -> Path:
    d = cache_dir() / "analysis_by_hash"
    d.mkdir(parents=True, exist_ok=True)
    return d


def hash_audio_file(
    audio_path: Path,
    chunk_bytes: int = 1 << 20,  # 1 MB chunks
) -> str:
    """SHA256 of a file's bytes. Streamed in chunks so memory stays flat
    regardless of file size. Suitable for the extracted mic WAVs since
    they're already canonicalized (16 kHz mono PCM)."""
    hasher = hashlib.sha256()
    with audio_path.open("rb") as f:
        while True:
            chunk = f.read(chunk_bytes)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def lookup(audio_hash: str) -> dict | None:
    """Return the cached AnalysisBundle JSON for this hash, or None."""
    path = _cache_dir() / f"{audio_hash}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        # Corrupt cache entry — drop it so the next run can rewrite.
        try:
            path.unlink()
        except OSError:
            pass
        return None


def store(audio_hash: str, bundle_dict: dict) -> None:
    """Persist an AnalysisBundle dict under its audio-hash key."""
    path = _cache_dir() / f"{audio_hash}.json"
    # Atomic-ish: write to a sibling temp + rename, so a crash mid-write
    # doesn't leave a half-written JSON that lookup() then can't parse.
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(bundle_dict, indent=2), encoding="utf-8")
    tmp.replace(path)
