"""Speech analysis: Silero VAD speech regions + Whisper word-level transcription.

Two complementary signals on the same mic-only 16 kHz WAV produced by `ingest`:

1. Silero VAD reports speech vs. non-speech boundaries at the audio level. This is
   the foundation for cut-point selection — we never want to cut mid-word, and we
   need to know exactly where speech actually begins and ends (down to ~30 ms),
   independent of what the transcriber thinks was said.

2. faster-whisper (large-v3) gives us the words themselves with per-word timing.
   This is what the LLM classifier later uses to decide *why* a pause exists.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Literal

import soundfile as sf
import torch
from faster_whisper import WhisperModel
from silero_vad import get_speech_timestamps, load_silero_vad

from .models import SpeechAnalysis, SpeechSegment, TranscriptSegment, Word

WhisperModelSize = Literal["tiny", "base", "small", "medium", "large-v3"]
ComputeType = Literal["int8", "int8_float16", "float16", "float32"]

SAMPLE_RATE = 16000

# Progress callback signature: (fraction_in_[0,1], human_message).
# Phase-naming convention: prefix the message with the phase, e.g.
# "Transcribing: 00:23 / 02:15". The UI splits on the first ":" if needed.
ProgressFn = Callable[[float, str], None]


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
        samples = samples.mean(axis=1)  # collapse to mono if multi-channel
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


def _fmt_t(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f"{m:02d}:{s:02d}"


def transcribe(
    audio_path: Path,
    model_size: WhisperModelSize = "large-v3",
    compute_type: ComputeType = "int8",
    language: str | None = None,
    beam_size: int = 5,
    progress: ProgressFn | None = None,
) -> tuple[list[TranscriptSegment], str, float, float]:
    """Run Whisper and return (segments, language, language_prob, duration).

    `compute_type="int8"` is the practical default on Apple Silicon CPU: large-v3
    runs in a tolerable time at minimal quality loss. The user can override to
    float32 on a beefier machine.

    If `progress` is given, it's called as transcription advances. faster-whisper
    yields segments incrementally as they're decoded, so we can drive a real
    progress bar from `segment.end / total_duration` rather than guessing.
    """
    device = "cpu"  # Apple Silicon: faster-whisper currently has no MPS backend.
    if torch.cuda.is_available():
        device = "cuda"

    if progress:
        progress(0.0, f"Loading Whisper {model_size} ({compute_type})...")
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    if progress:
        progress(0.0, "Starting transcription...")
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=language,
        beam_size=beam_size,
        word_timestamps=True,
        vad_filter=False,  # we run our own VAD separately; don't double-gate.
        condition_on_previous_text=True,
    )
    total = float(info.duration) or 1.0

    out: list[TranscriptSegment] = []
    for s in segments_iter:
        if progress:
            frac = min(max(float(s.end) / total, 0.0), 1.0)
            progress(
                frac,
                f"Transcribing: {_fmt_t(s.end)} / {_fmt_t(total)}",
            )
        words = [
            Word(
                text=w.word,
                start=float(w.start),
                end=float(w.end),
                probability=float(w.probability) if w.probability is not None else None,
            )
            for w in (s.words or [])
        ]
        out.append(
            TranscriptSegment(
                id=s.id,
                start=float(s.start),
                end=float(s.end),
                text=s.text,
                words=words,
                avg_logprob=float(s.avg_logprob) if s.avg_logprob is not None else None,
                no_speech_prob=(
                    float(s.no_speech_prob) if s.no_speech_prob is not None else None
                ),
            )
        )
    if progress:
        progress(1.0, f"Transcribed {len(out)} segments")
    return out, info.language, float(info.language_probability), float(info.duration)


def analyze(
    audio_path: Path,
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
