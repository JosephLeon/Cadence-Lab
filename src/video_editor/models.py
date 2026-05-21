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
