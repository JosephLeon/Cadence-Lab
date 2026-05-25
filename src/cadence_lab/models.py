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
    """The full output of `cadence-lab analyze`: ingest + speech analysis."""

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


# ─── Stage 4: cut planning ────────────────────────────────────────────────────

CutKind = Literal[
    "pause_cut", "pause_trim", "filler_cut", "retake_cut", "custom_cut"
]


class KeepSegment(BaseModel):
    """One contiguous time range of the source that survives editing.

    The renderer (stage 5) concatenates these in order, applying short audio
    crossfades at each boundary.
    """

    source_start: float
    source_end: float

    @property
    def duration(self) -> float:
        return self.source_end - self.source_start


class CutOperation(BaseModel):
    """One classifier-driven edit — for the audit log + review UI.

    Multiple `CutOperation`s may collapse into a single keep-segment boundary
    after interval merging (e.g. a retake that swallows several filler cuts
    within it). The audit log preserves original intent regardless.
    """

    source_start: float
    source_end: float
    kind: CutKind
    reason: str

    @property
    def duration_removed(self) -> float:
        return self.source_end - self.source_start


class CutPlanParams(BaseModel):
    """Knobs that control how the classifier output becomes a concrete plan."""

    crossfade_ms: int = 20
    # Symmetric pad applied to every filler cut to avoid clipping adjacent
    # words on either side — Whisper timestamps have ~50ms jitter.
    filler_pad_ms: int = 20
    # Used when a "trim" action has no explicit trim_to_ms (almost always breaths).
    default_breath_ms: int = 150
    # Drop any keep-segment shorter than this — it would be inaudible after
    # crossfade and is almost certainly an artifact of overlapping cuts.
    min_keep_ms: int = 80


class CutPlan(BaseModel):
    """Edit decision list — the contract between stage 4 and stage 5."""

    source_duration: float
    output_duration: float
    keeps: list[KeepSegment]
    cuts: list[CutOperation]  # audit log; original intents before merging
    params: CutPlanParams
    schema_version: Literal[1] = 1

    @property
    def time_saved_seconds(self) -> float:
        return self.source_duration - self.output_duration

    @property
    def time_saved_pct(self) -> float:
        if self.source_duration <= 0:
            return 0.0
        return 100.0 * self.time_saved_seconds / self.source_duration


# ─── Audio events (sniffles / throat clears / etc) ──────────────────────────


AudioEventKind = Literal[
    "sniff",
    "throat_clear",
    "cough",
    "sneeze",
    "hiccup",
    "burp",
]


class AudioEvent(BaseModel):
    """One non-speech audio event detected by the opt-in event-detection
    pass. Source-time seconds. ``confidence`` is the model's per-frame
    max sigmoid probability for the event window."""

    start: float
    end: float
    kind: AudioEventKind
    confidence: float


class AudioEventBundle(BaseModel):
    """Persisted output of an event-detection run; one per source."""

    events: list[AudioEvent]
    source_duration: float
    model: str = "panns-cnn14-sed"
    schema_version: Literal[1] = 1
