"""Tests for path helpers — the filename schema is a quiet API.

Filenames are how the user identifies what they're looking at on disk; a
silent change to the schema (e.g. dropping the `-neural` suffix) means the
user can't tell two renders apart. These tests pin the contract.
"""

from __future__ import annotations

from pathlib import Path

from cadence_lab.paths import denoised_wav_path, rendered_path


def test_rendered_path_plain(isolated_output_dir: Path):
    src = Path("/tmp/sources/recording.mov")
    out = rendered_path(src)
    assert out.name == "recording.edited.mp4"


def test_rendered_path_classical_enhance(isolated_output_dir: Path):
    src = Path("/tmp/sources/recording.mov")
    out = rendered_path(src, enhance_speech="medium", enhance_engine="classical")
    assert out.name == "recording.edited.enhance-medium.mp4"


def test_rendered_path_neural_enhance_appends_neural_tag(isolated_output_dir: Path):
    """Neural engine must be visible in the filename — A/B comparisons rely
    on it. Classical is the default and stays unmarked."""
    src = Path("/tmp/sources/recording.mov")
    out = rendered_path(src, enhance_speech="medium", enhance_engine="neural")
    assert out.name == "recording.edited.enhance-medium-neural.mp4"


def test_rendered_path_neural_without_enhance_is_unmarked(isolated_output_dir: Path):
    """If enhancement is off, the engine doesn't get added — neural with
    no enhancement is meaningless and shouldn't pollute the filename."""
    src = Path("/tmp/sources/recording.mov")
    out = rendered_path(src, enhance_speech="off", enhance_engine="neural")
    assert out.name == "recording.edited.mp4"


def test_rendered_path_with_ducking(isolated_output_dir: Path):
    src = Path("/tmp/sources/recording.mov")
    out = rendered_path(
        src,
        enhance_speech="high",
        auto_duck=True,
        ducking_db=-12,
        source_audio_track_count=2,
    )
    assert out.name == "recording.edited.enhance-high.duck-12.mp4"


def test_rendered_path_ducking_skipped_for_mono_source(isolated_output_dir: Path):
    """Auto-duck on a single-track source is a no-op — it must not appear
    in the filename or two renders would falsely look different."""
    src = Path("/tmp/sources/recording.mov")
    out = rendered_path(
        src,
        enhance_speech="off",
        auto_duck=True,
        ducking_db=-8,
        source_audio_track_count=1,
    )
    assert out.name == "recording.edited.mp4"


def test_denoised_wav_path_encodes_strength(isolated_output_dir: Path):
    """Per-strength caching — re-rendering at the same strength must hit
    the same cached WAV; different strengths must be separate files."""
    src = Path("/tmp/sources/recording.mov")
    low = denoised_wav_path(src, "low")
    med = denoised_wav_path(src, "medium")
    high = denoised_wav_path(src, "high")
    assert low.name == "recording.mic.denoised-low.wav"
    assert med.name == "recording.mic.denoised-medium.wav"
    assert high.name == "recording.mic.denoised-high.wav"
    assert len({low, med, high}) == 3
