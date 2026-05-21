"""Speech analysis: Silero VAD speech regions + Whisper word-level transcription.

Two complementary signals on the same mic-only 16 kHz WAV produced by `ingest`:

1. Silero VAD reports speech vs. non-speech boundaries at the audio level. This is
   the foundation for cut-point selection — we never want to cut mid-word, and we
   need to know exactly where speech actually begins and ends (down to ~30 ms),
   independent of what the transcriber thinks was said.

2. Whisper (large-v3) gives us the words themselves with per-word timing. This is
   what the LLM classifier later uses to decide *why* a pause exists. The
   transcription itself runs through one of two backends — see `backends.py`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import soundfile as sf
import torch
from silero_vad import get_speech_timestamps, load_silero_vad

from .backends import (
    Backend,
    ComputeType,
    WhisperModelSize,
    transcribe_groq,
    transcribe_local,
)
from .models import SpeechAnalysis, SpeechSegment, TranscriptSegment

SAMPLE_RATE = 16000

# Progress callback signature: (fraction_in_[0,1], human_message).
ProgressFn = Callable[[float, str], None]

# Re-export so existing CLI/UI imports keep working.
__all__ = [
    "Backend",
    "ComputeType",
    "ProgressFn",
    "SAMPLE_RATE",
    "WhisperModelSize",
    "analyze",
    "run_vad",
    "transcribe",
]


def run_vad(
    audio_path: Path,
    min_speech_ms: int = 200,
    min_silence_ms: int = 200,
    speech_pad_ms: int = 60,
) -> list[SpeechSegment]:
    """Return speech regions detected by Silero VAD.

    Defaults are tuned for talking-head / tutorial content: short utterances are
    preserved (200 ms min speech), small inter-word gaps stay merged (200 ms min
    silence), and each region is padded slightly so we don't clip soft consonants.
    """
    model = load_silero_vad()
    # We control the WAV format (16 kHz mono PCM written by ingest), so loading
    # via soundfile avoids torchaudio 2.11's torchcodec dependency.
    samples, sr = sf.read(str(audio_path), dtype="float32", always_2d=False)
    if sr != SAMPLE_RATE:
        raise ValueError(
            f"expected {SAMPLE_RATE} Hz audio, got {sr} Hz — re-run ingest"
        )
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    wav = torch.from_numpy(samples)
    raw = get_speech_timestamps(
        wav,
        model,
        sampling_rate=SAMPLE_RATE,
        min_speech_duration_ms=min_speech_ms,
        min_silence_duration_ms=min_silence_ms,
        speech_pad_ms=speech_pad_ms,
        return_seconds=True,
    )
    return [SpeechSegment(start=float(r["start"]), end=float(r["end"])) for r in raw]


def transcribe(
    audio_path: Path,
    backend: Backend = "groq",
    model_size: WhisperModelSize = "large-v3",
    compute_type: ComputeType = "int8",
    language: str | None = None,
    beam_size: int = 5,
    progress: ProgressFn | None = None,
) -> tuple[list[TranscriptSegment], str, float, float]:
    """Dispatch to the chosen backend; both return the same tuple shape."""
    if backend == "groq":
        return transcribe_groq(audio_path, language=language, progress=progress)
    return transcribe_local(
        audio_path,
        model_size=model_size,
        compute_type=compute_type,
        language=language,
        beam_size=beam_size,
        progress=progress,
    )


def analyze(
    audio_path: Path,
    backend: Backend = "groq",
    model_size: WhisperModelSize = "large-v3",
    compute_type: ComputeType = "int8",
    language: str | None = None,
    progress: ProgressFn | None = None,
) -> SpeechAnalysis:
    if progress:
        progress(0.0, "Running voice activity detection...")
    vad = run_vad(audio_path)
    if progress:
        progress(0.0, f"VAD found {len(vad)} speech regions")

    segments, lang, lang_prob, duration = transcribe(
        audio_path,
        backend=backend,
        model_size=model_size,
        compute_type=compute_type,
        language=language,
        progress=progress,
    )
    return SpeechAnalysis(
        audio_path=audio_path.resolve(),
        duration_seconds=duration,
        language=lang,
        language_probability=lang_prob,
        vad_segments=vad,
        segments=segments,
    )
