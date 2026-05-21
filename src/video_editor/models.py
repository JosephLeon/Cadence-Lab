from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field


class AudioTrack(BaseModel):
    """One audio stream inside the source video as reported by ffprobe."""

    index: int
    codec: str
    channels: int
    sample_rate: int
    language: str | None = None
    title: str | None = None
    duration_seconds: float | None = None


class SourceProbe(BaseModel):
    """Everything we learn about the source file before processing."""

    path: Path
    duration_seconds: float
    container: str
    video_codec: str | None
    width: int | None
    height: int | None
    frame_rate: float | None
    is_variable_frame_rate: bool
    audio_tracks: list[AudioTrack]


class IngestResult(BaseModel):
    """Output of the ingest stage."""

    source: SourceProbe
    mic_track_index: int
    normalized_audio_path: Path = Field(
        description="16 kHz mono WAV of the mic track, suitable for VAD/Whisper input."
    )
    normalized_audio_sample_rate: int = 16000


class SpeechSegment(BaseModel):
    """A contiguous region where Silero VAD reports speech."""

    start: float
    end: float


class Word(BaseModel):
    """One transcribed word with timing and confidence."""

    text: str
    start: float
    end: float
    probability: float | None = None


class TranscriptSegment(BaseModel):
    """A Whisper segment — a sentence-ish chunk containing words."""

    id: int
    start: float
    end: float
    text: str
    words: list[Word]
    avg_logprob: float | None = None
    no_speech_prob: float | None = None


class SpeechAnalysis(BaseModel):
    """Combined output of VAD + transcription on the mic track."""

    audio_path: Path
    duration_seconds: float
    language: str
    language_probability: float
    vad_segments: list[SpeechSegment]
    segments: list[TranscriptSegment]

    @property
    def words(self) -> list[Word]:
        return [w for seg in self.segments for w in seg.words]


class AnalysisBundle(BaseModel):
    """The full output of `video-editor analyze`: ingest + speech analysis."""

    ingest: IngestResult
    speech: SpeechAnalysis
    schema_version: Literal[1] = 1


# ─── Stage 3: pause/filler classification ─────────────────────────────────────

PauseCategory = Literal[
    "filler",       # empty thinking pause, cut entirely
    "hesitation",   # mid-sentence stumble, cut entirely
    "breath",       # natural inhale/exhale, trim to ~150ms (do NOT cut)
    "emphasis",     # intentional dramatic beat, keep
    "pre_laughter", # speaker about to laugh, keep
    "transition",   # topic change, keep or trim moderately
    "listening",    # waiting for off-camera cue, keep
]
PauseAction = Literal["cut", "trim", "keep"]
FillerAction = Literal["cut", "keep"]


class PauseCandidate(BaseModel):
    """A gap between consecutive words that exceeds the classification threshold."""

    id: int
    start: float  # end of preceding word
    end: float    # start of following word

    @property
    def duration(self) -> float:
        return self.end - self.start


class FillerCandidate(BaseModel):
    """A word matched by the filler-token list, queued for context-aware judgment."""

    id: int
    word_index: int  # index into SpeechAnalysis.words (the flattened list)
    text: str
    start: float
    end: float


class ClassifiedPause(BaseModel):
    id: int
    category: PauseCategory
    action: PauseAction
    trim_to_ms: int | None = None
    reason: str


class ClassifiedFiller(BaseModel):
    id: int
    action: FillerAction
    reason: str


class Retake(BaseModel):
    """A semantic duplicate detected by the classifier — speaker repeated themselves."""

    cut_start: float
    cut_end: float
    keep_start: float
    keep_end: float
    reason: str


class Classification(BaseModel):
    pauses: list[ClassifiedPause]
    fillers: list[ClassifiedFiller]
    retakes: list[Retake]


class ClassificationBundle(BaseModel):
    """Stage-3 output: pause/filler candidates + Claude's classification.

    Persisted alongside the analysis JSON, consumed by the cut planner (stage 4).
    """

    pause_candidates: list[PauseCandidate]
    filler_candidates: list[FillerCandidate]
    classification: Classification
    model_used: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    schema_version: Literal[1] = 1
