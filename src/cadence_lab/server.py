"""FastAPI sidecar — exposes the pipeline to the Tauri/React frontend.

## Architecture

The Tauri desktop app launches this as a sidecar process on a fixed localhost
port. The React frontend (running inside the Tauri webview) talks to it via
HTTP + Server-Sent Events.

```
┌─────────────────────────────────────────┐
│  Tauri shell (native window)            │
│  ┌───────────────────────────────────┐  │
│  │  React frontend (webview)         │  │
│  │  - editor UI                      │  │
│  │  - video player                   │  │
│  │  - timeline                       │  │
│  │  - review panel                   │  │
│  └────────────┬──────────────────────┘  │
│               │ fetch + SSE             │
│               ▼                         │
│  ┌───────────────────────────────────┐  │
│  │  FastAPI sidecar (this file)      │  │
│  │  - localhost:27182                │  │
│  │  - routes → existing pipeline     │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## Endpoint shape

- **Sync endpoints** for fast operations (probe, plan, apply_overrides) —
  return the result directly.
- **Async endpoints** for long-running ones (analyze, classify, render) —
  return a ``{"job_id": ...}`` immediately, then the frontend polls
  ``GET /jobs/{id}`` or subscribes to ``GET /jobs/{id}/events`` (SSE) for
  progress.

## Why sync HTTP + SSE instead of WebSockets

- One-way progress: server → client. SSE is the right primitive.
- Auto-reconnect built into browsers' EventSource.
- Plays nicely with FastAPI's StreamingResponse — no extra dependency.
- WebSockets would be overkill and add async-context complexity.

## Why threads instead of asyncio for the work

The pipeline stages are CPU/IO-bound sync code (ffmpeg subprocesses,
faster-whisper inference, ctypes calls into VAD models, sync SDK calls).
Trying to await them would require running them in a threadpool anyway —
so we just run them in a ThreadPoolExecutor and call it a day.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

from .classifier import classify as run_classify
from .ingest import IngestError, ingest, probe
from .models import (
    AnalysisBundle,
    AudioEvent,
    AudioEventBundle,
    Classification,
    ClassificationBundle,
    CutPlan,
    CutPlanParams,
    KeepSegment,
    SourceProbe,
)
from .paths import (
    analysis_path,
    cache_dir,
    classified_path,
    events_path,
    frame_index_path,
    mic_wav_path,
    output_dir,
    plan_path,
    rendered_path,
    thumbnail_cache_path,
)
from .planner import plan_cuts
from .renderer import (
    RenderError,
    SpliceClipSpec,
    render as run_render,
    splice_render,
)
from .reviewer import apply_overrides, extract_audio_clip
from .speech import analyze as run_analyze


# ─── Job tracking ────────────────────────────────────────────────────────────


JobStatus = Literal["pending", "running", "done", "error"]


@dataclass
class Job:
    """One async pipeline run. Thread-safe via the GIL for our simple usage."""

    id: str
    kind: Literal[
    "analyze", "classify", "render", "splice", "detect_events", "index_frames"
]
    status: JobStatus = "pending"
    progress: float = 0.0
    message: str = ""
    result: dict[str, Any] | None = None
    error: str | None = None
    # Replay log so a late-subscribing SSE client gets full history.
    events: list[dict[str, Any]] = field(default_factory=list)
    # Per-job condition variable so SSE generators can block efficiently
    # waiting for new events instead of polling.
    _cv: threading.Condition = field(default_factory=threading.Condition)

    def append_event(self, **kwargs: Any) -> None:
        with self._cv:
            self.events.append(kwargs)
            self._cv.notify_all()

    def finish(
        self,
        status: Literal["done", "error"],
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        with self._cv:
            self.status = status
            self.result = result
            self.error = error
            self.events.append({"_terminal": True, "status": status})
            self._cv.notify_all()


_jobs: dict[str, Job] = {}
# Two concurrent workers is plenty for desktop use; running two ffmpeg
# encodes at once would just thrash one CPU.
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="cadence-job")


def _new_job(kind: Literal[
    "analyze", "classify", "render", "splice", "detect_events", "index_frames"
]) -> Job:
    job = Job(id=str(uuid.uuid4()), kind=kind)
    _jobs[job.id] = job
    return job


def _progress_for(job: Job):
    """Build the (frac, message) callback the pipeline stages expect."""
    def cb(frac: float, message: str) -> None:
        job.progress = max(0.0, min(1.0, float(frac)))
        job.message = message
        job.append_event(progress=job.progress, message=message)
    return cb


# ─── FastAPI app ─────────────────────────────────────────────────────────────


app = FastAPI(
    title="Cadence Lab",
    description="Local pipeline server for the Cadence Lab desktop app.",
    version="0.1.0",
)

# CORS for local development — frontend dev server usually runs on a
# different port (Vite defaults to 5173, Tauri dev to 1420).
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:1420",  # tauri dev
        "http://localhost:5173",  # vite dev
        "http://localhost:3000",  # next.js dev
        "tauri://localhost",       # tauri prod
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Simple sync endpoints ───────────────────────────────────────────────────


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "cadence-lab"}


# ─── Projects ────────────────────────────────────────────────────────────────


from . import projects as _projects_mod  # noqa: E402


class CreateProjectRequest(BaseModel):
    name: str


class AddSourceRequest(BaseModel):
    path: str
    mode: Literal["copy", "reference"] = "copy"


@app.get("/projects")
def list_projects_endpoint() -> dict[str, Any]:
    """Return every project found under the projects root, newest first.

    Broken projects (no manifest, or unparseable) appear with ``broken=True``
    so the UI can surface them instead of silently dropping them."""
    return {
        "root": str(_projects_mod.projects_root()),
        "projects": _projects_mod.list_projects(),
    }


@app.post("/projects")
def create_project_endpoint(req: CreateProjectRequest) -> _projects_mod.Project:
    try:
        return _projects_mod.create_project(req.name)
    except _projects_mod.ProjectError as e:
        raise HTTPException(400, str(e))


@app.get("/projects/{slug}")
def load_project_endpoint(slug: str) -> _projects_mod.Project:
    try:
        return _projects_mod.load_project(slug)
    except _projects_mod.ProjectNotFound as e:
        raise HTTPException(404, str(e))
    except _projects_mod.ProjectError as e:
        raise HTTPException(400, str(e))


@app.put("/projects/{slug}")
def save_project_endpoint(
    slug: str, body: _projects_mod.Project
) -> _projects_mod.Project:
    """Replace the project's manifest in full.

    Frontend owns all state — every mutation sends back the whole manifest.
    We refuse if the body's slug doesn't match the URL slug, so the client
    can't accidentally rename a project's directory."""
    if body.slug != slug:
        raise HTTPException(400, f"slug mismatch: URL={slug}, body={body.slug}")
    _projects_mod.save_project(body)
    return body


@app.delete("/projects/{slug}")
def delete_project_endpoint(slug: str) -> dict[str, str]:
    """Permanently delete a project directory and everything in it.
    Irreversible."""
    try:
        _projects_mod.delete_project(slug)
    except _projects_mod.ProjectNotFound as e:
        raise HTTPException(404, str(e))
    except _projects_mod.ProjectError as e:
        raise HTTPException(400, str(e))
    return {"status": "deleted", "slug": slug}


@app.delete("/projects/{slug}/sources")
def remove_source_endpoint(
    slug: str,
    path: str = Query(..., description="The source's `path` field as stored in the manifest"),
    delete_file: bool = Query(False, description="If True and the source was copied, also unlink the file under sources/"),
) -> _projects_mod.Project:
    """Remove a source from a project. Returns the updated manifest so the
    frontend can sync state in one round trip — same pattern as the add
    endpoint."""
    try:
        project = _projects_mod.load_project(slug)
    except _projects_mod.ProjectNotFound as e:
        raise HTTPException(404, str(e))
    removed = _projects_mod.remove_source(
        project, path, delete_copied_file=delete_file
    )
    if not removed:
        raise HTTPException(
            404, f"no source with path={path!r} in project {slug}"
        )
    _projects_mod.save_project(project)
    return project


@app.post("/projects/{slug}/sources")
def add_source_endpoint(
    slug: str, req: AddSourceRequest
) -> _projects_mod.Project:
    """Add a source video to the project. Returns the updated manifest so
    the frontend can sync state in one round trip."""
    try:
        project = _projects_mod.load_project(slug)
    except _projects_mod.ProjectNotFound as e:
        raise HTTPException(404, str(e))
    try:
        _projects_mod.add_source(project, Path(req.path), mode=req.mode)
    except _projects_mod.ProjectError as e:
        raise HTTPException(400, str(e))
    _projects_mod.save_project(project)
    return project


class ProbeRequest(BaseModel):
    source_path: str


class CanonicalPaths(BaseModel):
    """Where each pipeline artifact would land for a given source — and
    whether it already exists on disk. Lets the frontend show "this is
    already analyzed/classified/rendered" without each client having to
    know the output-dir convention."""
    analysis: str
    classified: str
    plan: str
    rendered: str
    mic_wav: str
    events: str
    frame_index: str
    analysis_exists: bool
    classified_exists: bool
    plan_exists: bool
    rendered_exists: bool
    mic_wav_exists: bool
    events_exists: bool
    frame_index_exists: bool


class ProbeResponse(BaseModel):
    source: SourceProbe
    paths: CanonicalPaths


def _canonical_paths(source: Path) -> CanonicalPaths:
    """Return per-source canonical paths.

    All artifact paths are project-aware via ``paths.artifacts_dir`` — for
    sources inside a workspace project, they land in ``<project>/artifacts/``;
    for sources outside any project, they fall back to ``<output_dir>/<stem>/``.

    The old "legacy flat layout" fallback was removed: it caused ghost
    artifacts from one project to be reported as belonging to another
    when two sources happened to share a filename stem.
    """
    ap = analysis_path(source)
    cp = classified_path(source)
    pp = plan_path(source)
    rp = rendered_path(source)
    mp = mic_wav_path(source)
    ep = events_path(source)
    fp = frame_index_path(source)
    return CanonicalPaths(
        analysis=str(ap),
        classified=str(cp),
        plan=str(pp),
        rendered=str(rp),
        mic_wav=str(mp),
        events=str(ep),
        frame_index=str(fp),
        analysis_exists=ap.exists(),
        classified_exists=cp.exists(),
        plan_exists=pp.exists(),
        rendered_exists=rp.exists(),
        mic_wav_exists=mp.exists(),
        events_exists=ep.exists(),
        frame_index_exists=fp.exists(),
    )


@app.post("/probe", response_model=ProbeResponse)
def probe_endpoint(req: ProbeRequest) -> ProbeResponse:
    src = Path(req.source_path).expanduser()
    if not src.exists():
        raise HTTPException(404, f"source not found: {src}")
    try:
        return ProbeResponse(
            source=probe(src),
            paths=_canonical_paths(src),
        )
    except IngestError as e:
        raise HTTPException(400, str(e)) from e


class CustomCutInput(BaseModel):
    start: float
    end: float
    reason: str = ""


class PlanRequest(BaseModel):
    analysis_path: str
    classified_path: str | None = None  # default: derive from output_dir
    # Per-classifier-item user overrides applied before planning. Key shape:
    # "pause:5" → "keep" | "trim" | "cut", "filler:3" → "keep" | "cut",
    # "retake:0" → "reject". Used by the review panel for re-plans.
    overrides: dict[str, str] | None = None
    # Arbitrary cuts the user or Cadence added on top of classifier cuts.
    # Source-time seconds. Merged with classifier cuts before complement.
    custom_cuts: list[CustomCutInput] | None = None
    crossfade_ms: int = 20
    filler_pad_ms: int = 20
    default_breath_ms: int = 150
    min_keep_ms: int = 80


class PlanResponse(BaseModel):
    plan: CutPlan
    plan_path: str  # echo back the file we wrote to


@app.post("/plan", response_model=PlanResponse)
def plan_endpoint(req: PlanRequest) -> PlanResponse:
    ap = Path(req.analysis_path).expanduser()
    if not ap.exists():
        raise HTTPException(404, f"analysis not found: {ap}")
    bundle = AnalysisBundle.model_validate_json(ap.read_text())

    cp = (
        Path(req.classified_path).expanduser()
        if req.classified_path
        else classified_path(bundle.ingest.source.path)
    )
    if not cp.exists():
        raise HTTPException(404, f"classification not found: {cp}")
    cls_bundle = ClassificationBundle.model_validate_json(cp.read_text())

    # Apply review-panel overrides (if any) without writing back to disk —
    # the classification.json stays the canonical original; overrides only
    # affect the resulting plan.
    if req.overrides:
        parsed = {_parse_override_key(k): v for k, v in req.overrides.items()}
        modified = apply_overrides(cls_bundle.classification, parsed)  # type: ignore[arg-type]
        cls_bundle = cls_bundle.model_copy(update={"classification": modified})

    custom_cuts_tuples = (
        [(c.start, c.end, c.reason) for c in req.custom_cuts]
        if req.custom_cuts
        else None
    )
    plan = plan_cuts(
        speech=bundle.speech,
        classification_bundle=cls_bundle,
        params=CutPlanParams(
            crossfade_ms=req.crossfade_ms,
            filler_pad_ms=req.filler_pad_ms,
            default_breath_ms=req.default_breath_ms,
            min_keep_ms=req.min_keep_ms,
        ),
        custom_cuts=custom_cuts_tuples,
    )

    # Persist alongside the analysis so the next stage finds it.
    out = plan_path(bundle.ingest.source.path)
    out.write_text(json.dumps(plan.model_dump(mode="json"), indent=2))
    return PlanResponse(plan=plan, plan_path=str(out))


class OverridesRequest(BaseModel):
    classified_path: str
    overrides: dict[str, str]  # JSON-friendly: "pause:5" → "keep" etc.


def _parse_override_key(key: str) -> tuple[str, int]:
    """Convert "pause:5" → ("pause", 5). The frontend sends string keys
    because JSON dicts can't have tuple keys."""
    kind, _, id_str = key.partition(":")
    return kind, int(id_str)


@app.post("/apply-overrides", response_model=Classification)
def apply_overrides_endpoint(req: OverridesRequest) -> Classification:
    """Return a new Classification with the frontend's overrides applied.

    Doesn't write to disk — the frontend posts the result back through
    /plan to materialize a new CutPlan.
    """
    cp = Path(req.classified_path).expanduser()
    if not cp.exists():
        raise HTTPException(404, f"classification not found: {cp}")
    bundle = ClassificationBundle.model_validate_json(cp.read_text())
    parsed: dict[tuple[str, int], str] = {
        _parse_override_key(k): v for k, v in req.overrides.items()
    }
    return apply_overrides(bundle.classification, parsed)  # type: ignore[arg-type]


# ─── Async (job-based) endpoints ─────────────────────────────────────────────


class AnalyzeRequest(BaseModel):
    source_path: str
    mic_track: int = 0
    backend: Literal["groq", "local"] = "groq"
    language: str | None = None


class JobHandle(BaseModel):
    job_id: str


@app.post("/analyze", response_model=JobHandle)
def analyze_endpoint(req: AnalyzeRequest) -> JobHandle:
    src = Path(req.source_path).expanduser()
    if not src.exists():
        raise HTTPException(404, f"source not found: {src}")

    job = _new_job("analyze")

    def run() -> None:
        try:
            job.status = "running"
            cb = _progress_for(job)
            cb(0.0, "Extracting mic-only audio...")
            ing = ingest(source=src, mic_track_index=req.mic_track)
            speech = run_analyze(
                audio_path=ing.normalized_audio_path,
                backend=req.backend,
                language=req.language,
                progress=cb,
            )
            bundle = AnalysisBundle(ingest=ing, speech=speech)
            out = analysis_path(src)
            out.write_text(json.dumps(bundle.model_dump(mode="json"), indent=2))
            job.finish("done", result={"analysis_path": str(out)})
        except Exception as e:
            job.finish("error", error=str(e))

    _executor.submit(run)
    return JobHandle(job_id=job.id)


class ClassifyRequest(BaseModel):
    analysis_path: str
    min_pause_ms: int = 250


@app.post("/classify", response_model=JobHandle)
def classify_endpoint(req: ClassifyRequest) -> JobHandle:
    ap = Path(req.analysis_path).expanduser()
    if not ap.exists():
        raise HTTPException(404, f"analysis not found: {ap}")
    bundle = AnalysisBundle.model_validate_json(ap.read_text())

    job = _new_job("classify")

    def run() -> None:
        try:
            job.status = "running"
            cb = _progress_for(job)
            result = run_classify(
                speech=bundle.speech,
                min_pause_seconds=req.min_pause_ms / 1000.0,
                progress=cb,
            )
            out = classified_path(bundle.ingest.source.path)
            out.write_text(json.dumps(result.model_dump(mode="json"), indent=2))
            job.finish("done", result={"classified_path": str(out)})
        except Exception as e:
            job.finish("error", error=str(e))

    _executor.submit(run)
    return JobHandle(job_id=job.id)


# ─── Audio-event detection (opt-in pipeline stage) ──────────────────────────


class DetectEventsRequest(BaseModel):
    """Run sniff/throat-clear/cough/etc detection on a source.

    Separate from `/analyze` because it's slow (PANNs CNN14 SED runs at
    roughly real-time on CPU) and most users never need it. Output is
    cached to ``<source>.events.json`` so subsequent reads are free."""
    source_path: str
    mic_track: int | None = None  # currently unused (we read the mic WAV)


@app.post("/detect-events", response_model=JobHandle)
def detect_events_endpoint(req: DetectEventsRequest) -> JobHandle:
    """Kick off the audio-event detection background job.

    Requires the mic WAV to exist (which it will if Analyze has run).
    If not, the job extracts the mic audio on the fly — same path as
    `/audio-peaks`.
    """
    src = Path(req.source_path).expanduser()
    if not src.exists():
        raise HTTPException(404, f"source not found: {src}")

    job = _new_job("detect_events")

    def run() -> None:
        try:
            job.status = "running"
            cb = _progress_for(job)
            cb(0.0, "Preparing audio…")
            # Reuse the audio-peaks decoder so video sources auto-extract
            # mic audio to the canonical cached path.
            audio_input = _ensure_decodable_audio(src)
            from .events import detect_events

            events = detect_events(audio_input, progress=cb)

            # Get duration from the WAV header for the bundle.
            import soundfile as sf

            with sf.SoundFile(str(audio_input)) as f:
                duration = len(f) / float(f.samplerate)

            bundle = AudioEventBundle(
                events=events,
                source_duration=duration,
            )
            out = events_path(src)
            out.write_text(
                json.dumps(bundle.model_dump(mode="json"), indent=2)
            )
            job.finish(
                "done",
                result={
                    "events_path": str(out),
                    "event_count": len(events),
                },
            )
        except Exception as e:
            job.finish("error", error=str(e))

    _executor.submit(run)
    return JobHandle(job_id=job.id)


@app.get("/events", response_model=AudioEventBundle)
def get_events(path: str = Query(..., description="Absolute path to source video")) -> AudioEventBundle:
    """Return the cached audio-event detection output for a source.

    Used by Cadence's `list_audio_events` tool to read the cached scan
    result. 404 if the scan hasn't been run for this source yet — the
    frontend can use that signal to surface the "Detect audio events"
    button or for Cadence to propose running the scan.
    """
    src = Path(path).expanduser()
    if not src.exists():
        raise HTTPException(404, f"source not found: {src}")
    ep = events_path(src)
    if not ep.exists():
        raise HTTPException(404, f"no events file at {ep}")
    return AudioEventBundle.model_validate_json(ep.read_text())


# ─── Semantic visual search (opt-in pipeline stage) ─────────────────────────


class IndexFramesRequest(BaseModel):
    """Build a CLIP frame-embedding index for a source so Cadence can
    answer 'find the part where X is on screen' queries. Slow and opt-in
    — runs as a background job."""
    source_path: str


@app.post("/index-frames", response_model=JobHandle)
def index_frames_endpoint(req: IndexFramesRequest) -> JobHandle:
    src = Path(req.source_path).expanduser()
    if not src.exists():
        raise HTTPException(404, f"source not found: {src}")

    job = _new_job("index_frames")

    def run() -> None:
        try:
            job.status = "running"
            cb = _progress_for(job)
            from .vision import index_frames

            out = frame_index_path(src)
            n = index_frames(src, out, progress=cb)
            job.finish(
                "done",
                result={"frame_index_path": str(out), "frame_count": n},
            )
        except Exception as e:
            job.finish("error", error=str(e))

    _executor.submit(run)
    return JobHandle(job_id=job.id)


class SearchContentRequest(BaseModel):
    source_path: str
    query: str
    top_k: int = 5


@app.post("/search-content")
def search_content_endpoint(req: SearchContentRequest) -> dict[str, Any]:
    """Search a previously-indexed source for visual matches to a text
    query. Returns ranked timestamps with similarity scores. 404 if the
    source isn't indexed yet — Cadence can use that signal to suggest
    running the indexing pass."""
    src = Path(req.source_path).expanduser()
    if not src.exists():
        raise HTTPException(404, f"source not found: {src}")
    idx = frame_index_path(src)
    if not idx.exists():
        raise HTTPException(404, f"no frame index for {src} — run /index-frames first")
    from .vision import search

    try:
        results = search(idx, req.query, top_k=req.top_k)
    except Exception as e:
        raise HTTPException(500, f"search failed: {e}") from e
    return {"query": req.query, "results": results}


SpeechEnhanceLevel = Literal["off", "low", "medium", "high"]


class AudioSettings(BaseModel):
    """AI audio enhancement settings applied at render time. Lives inside
    RenderRequest. All optional — defaults to no enhancement."""

    enhance_speech: SpeechEnhanceLevel = "off"
    auto_duck: bool = False
    ducking_db: int = -8  # negative: lowers other tracks by this much


class RenderRequest(BaseModel):
    """Render a video. Two modes, distinguished by which path the caller
    supplies:

    - **Pacing mode** (the AI pipeline output): caller passes ``analysis_path``
      (and optionally ``plan_path``). The plan's cuts are applied and audio
      settings, if present, are baked in. This is the existing behavior.
    - **Audio-only mode**: caller passes ``source_path`` instead. We render
      the *whole* source — no cuts — with the audio enhancement chain
      applied. Doesn't require the AI pipeline to have run.

    Pacing mode also accepts ``overrides`` and ``custom_cuts``. When either
    is provided, the render re-runs the planner internally before encoding,
    so the latest session state is always reflected — no stale-plan footgun.
    """
    analysis_path: str | None = None
    plan_path: str | None = None
    source_path: str | None = None  # audio-only mode
    audio_track: int | None = None
    encoder: Literal["auto", "h264_videotoolbox", "libx264"] = "auto"
    audio_bitrate: str = "192k"
    audio: AudioSettings | None = None
    # Pacing-mode re-plan inputs. When set, /render re-runs the planner
    # with these on top of the stored classification before encoding,
    # so the user's latest overrides + custom cuts always make it in.
    overrides: dict[str, str] | None = None
    custom_cuts: list[CustomCutInput] | None = None
    # If set, the rendered MP4 is placed under the project's renders/ dir
    # with an `rNNN` ID prefix, and a render_history entry is appended.
    project_slug: str | None = None


@app.post("/render", response_model=JobHandle)
def render_endpoint(req: RenderRequest) -> JobHandle:
    # ─── Resolve mode: pacing (analysis + plan) or audio-only (source) ──
    audio_only = req.source_path is not None and req.analysis_path is None
    if not audio_only and not req.analysis_path:
        raise HTTPException(
            400,
            "render request needs either analysis_path (pacing mode) or "
            "source_path (audio-only mode)",
        )

    if audio_only:
        src = Path(req.source_path or "").expanduser()
        if not src.exists():
            raise HTTPException(404, f"source video not found: {src}")
        # Probe so we know source duration + audio tracks. Cheap (single
        # ffprobe call) and avoids depending on the AI pipeline.
        try:
            source_probe = probe(src)
        except (IngestError, Exception) as e:
            raise HTTPException(400, f"probe failed: {e}")
        audio_track_count = len(source_probe.audio_tracks)
        # Trivial plan: keep the whole source. The renderer's per-segment
        # trim + fade machinery still runs but on a single segment, which
        # is fine — gives us audio enhancement without any cuts.
        plan = CutPlan(
            source_duration=source_probe.duration_seconds,
            output_duration=source_probe.duration_seconds,
            keeps=[
                KeepSegment(
                    source_start=0.0,
                    source_end=source_probe.duration_seconds,
                )
            ],
            cuts=[],
            params=CutPlanParams(),
        )
        track = (
            req.audio_track
            if req.audio_track is not None
            else 0
        )
    else:
        ap = Path(req.analysis_path or "").expanduser()
        if not ap.exists():
            raise HTTPException(404, f"analysis not found: {ap}")
        bundle = AnalysisBundle.model_validate_json(ap.read_text())

        # If the caller passed overrides or custom_cuts, re-run the planner
        # in-process so the render reflects current session state. Plan is
        # interval algebra — basically free, no separate disk round-trip.
        if req.overrides is not None or req.custom_cuts is not None:
            cp = classified_path(bundle.ingest.source.path)
            if not cp.exists():
                raise HTTPException(404, f"classification not found: {cp}")
            cls_bundle = ClassificationBundle.model_validate_json(
                cp.read_text()
            )
            if req.overrides:
                from .reviewer import apply_overrides

                parsed_ovr = {
                    _parse_override_key(k): v
                    for k, v in req.overrides.items()
                }
                modified = apply_overrides(
                    cls_bundle.classification, parsed_ovr  # type: ignore[arg-type]
                )
                cls_bundle = cls_bundle.model_copy(
                    update={"classification": modified}
                )
            custom_cut_tuples = (
                [(c.start, c.end, c.reason) for c in req.custom_cuts]
                if req.custom_cuts
                else None
            )
            plan = plan_cuts(
                speech=bundle.speech,
                classification_bundle=cls_bundle,
                custom_cuts=custom_cut_tuples,
            )
        else:
            pp = (
                Path(req.plan_path).expanduser()
                if req.plan_path
                else plan_path(bundle.ingest.source.path)
            )
            if not pp.exists():
                raise HTTPException(404, f"plan not found: {pp}")
            plan = CutPlan.model_validate_json(pp.read_text())

        src = bundle.ingest.source.path
        if not src.exists():
            raise HTTPException(404, f"source video not found: {src}")

        audio_track_count = len(bundle.ingest.source.audio_tracks)
        track = (
            req.audio_track
            if req.audio_track is not None
            else bundle.ingest.mic_track_index
        )

    # ─── Output routing + filename ───────────────────────────────────────
    project: _projects_mod.Project | None = None
    render_id: str | None = None
    audio_suffix_parts: list[str] = []
    if req.audio and req.audio.enhance_speech != "off":
        audio_suffix_parts.append(f"enhance-{req.audio.enhance_speech}")
    if (
        req.audio
        and req.audio.auto_duck
        and audio_track_count > 1
    ):
        audio_suffix_parts.append(f"duck{req.audio.ducking_db}")
    audio_suffix = ("." + ".".join(audio_suffix_parts)) if audio_suffix_parts else ""
    # "paced" suffix only appears for pacing mode; audio-only renders are
    # named `r001.<stem>.enhance-medium.mp4` so the user can tell at a
    # glance that no AI cuts were applied.
    mode_suffix = "" if audio_only else ".paced"

    if req.project_slug:
        try:
            project = _projects_mod.load_project(req.project_slug)
        except _projects_mod.ProjectNotFound as e:
            raise HTTPException(404, f"project not found: {e}")
        render_id = _projects_mod.next_render_id(project)
        renders_dir = _projects_mod.project_dir_path(project.slug) / "renders"
        renders_dir.mkdir(parents=True, exist_ok=True)
        out = renders_dir / f"{render_id}.{src.stem}{mode_suffix}{audio_suffix}.mp4"
    else:
        out = rendered_path(
            src,
            enhance_speech=(req.audio.enhance_speech if req.audio else "off"),
            auto_duck=(req.audio.auto_duck if req.audio else False),
            ducking_db=(req.audio.ducking_db if req.audio else -8),
            source_audio_track_count=audio_track_count,
        )

    job = _new_job("render")

    def run() -> None:
        try:
            job.status = "running"
            cb = _progress_for(job)
            run_render(
                source=src,
                plan=plan,
                output_path=out,
                audio_track_index=track,
                encoder=req.encoder,
                audio_bitrate=req.audio_bitrate,
                enhance_speech=(req.audio.enhance_speech if req.audio else "off"),
                auto_duck=(req.audio.auto_duck if req.audio else False),
                ducking_db=(req.audio.ducking_db if req.audio else -8),
                source_audio_track_count=audio_track_count,
                progress=cb,
            )
            size = out.stat().st_size

            if project and render_id:
                rel = out.relative_to(
                    _projects_mod.project_dir_path(project.slug)
                ).as_posix()
                proj_root = _projects_mod.project_dir_path(project.slug)
                try:
                    source_rel = src.resolve().relative_to(proj_root).as_posix()
                except ValueError:
                    source_rel = str(src)
                label_prefix = "Audio render" if audio_only else "AI render"
                project.render_history.append(
                    _projects_mod.RenderHistoryEntry(
                        id=render_id,
                        type="ai_render",
                        source=source_rel,
                        input_render_id=None,
                        settings={
                            "mode": "audio_only" if audio_only else "paced",
                            "encoder": req.encoder,
                            "audio_bitrate": req.audio_bitrate,
                            "audio": (
                                req.audio.model_dump() if req.audio else None
                            ),
                        },
                        output=rel,
                        label=f"{label_prefix} · {src.stem}{audio_suffix or ''}",
                        timestamp=datetime.now(timezone.utc).isoformat(
                            timespec="seconds"
                        ),
                        size_bytes=size,
                    )
                )
                _projects_mod.save_project(project)

            job.finish(
                "done",
                result={
                    "rendered_path": str(out),
                    "size_bytes": size,
                    "render_id": render_id,
                    "project_slug": project.slug if project else None,
                },
            )
        except (RenderError, Exception) as e:
            job.finish("error", error=str(e))

    _executor.submit(run)
    return JobHandle(job_id=job.id)


# ─── Splice render (multi-clip assembly) ─────────────────────────────────────


class SpliceClipInput(BaseModel):
    """One entry on the splice timeline. ``kind="video"`` requires source_path
    + source_start + source_end; ``kind="blank"`` requires ``duration``."""
    kind: Literal["video", "blank"]
    source_path: str | None = None
    source_start: float = 0.0
    source_end: float = 0.0
    duration: float = 0.0


class SpliceRequest(BaseModel):
    clips: list[SpliceClipInput]
    output_name: str
    target_width: int = 1920
    target_height: int = 1080
    target_fps: int = 30
    encoder: Literal["auto", "h264_videotoolbox", "libx264"] = "auto"
    audio_bitrate: str = "192k"
    # If set, output is placed under the project's renders/ dir and a
    # render_history entry is appended to the manifest.
    project_slug: str | None = None


_SAFE_NAME_CHARS = set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_."
)


def _sanitize_export_name(name: str) -> str:
    """Strip path separators and disallowed characters from a user-supplied
    output name. Disallows leading dots so we don't create hidden files."""
    cleaned = "".join(c if c in _SAFE_NAME_CHARS else "_" for c in name.strip())
    cleaned = cleaned.lstrip(".")
    if not cleaned:
        raise HTTPException(400, "output_name is empty after sanitization")
    if cleaned.lower().endswith(".mp4"):
        cleaned = cleaned[:-4]
    return cleaned


@app.post("/splice/render", response_model=JobHandle)
def splice_render_endpoint(req: SpliceRequest) -> JobHandle:
    """Assemble the splice timeline into a single MP4 under ``output_dir()``.

    Output filename: ``<output_dir>/<sanitized_name>.mp4``. Existing files
    are overwritten — the frontend prompts the user for a name and can
    suggest unique ones if it wants to preserve previous exports.
    """
    if not req.clips:
        raise HTTPException(400, "splice request has no clips")

    specs: list[SpliceClipSpec] = []
    for c in req.clips:
        if c.kind == "video":
            if not c.source_path:
                raise HTTPException(400, "video clip missing source_path")
            specs.append(
                SpliceClipSpec(
                    kind="video",
                    source_path=Path(c.source_path),
                    source_start=c.source_start,
                    source_end=c.source_end,
                )
            )
        else:
            if c.duration <= 0:
                raise HTTPException(400, "blank clip needs positive duration")
            specs.append(SpliceClipSpec(kind="blank", duration=c.duration))

    safe_name = _sanitize_export_name(req.output_name)

    # Route output: project's renders/ dir if a project is active, otherwise
    # the legacy files/ directory.
    project: _projects_mod.Project | None = None
    render_id: str | None = None
    if req.project_slug:
        try:
            project = _projects_mod.load_project(req.project_slug)
        except _projects_mod.ProjectNotFound as e:
            raise HTTPException(404, f"project not found: {e}")
        render_id = _projects_mod.next_render_id(project)
        renders_dir = _projects_mod.project_dir_path(project.slug) / "renders"
        renders_dir.mkdir(parents=True, exist_ok=True)
        out = renders_dir / f"{render_id}.{safe_name}.mp4"
    else:
        out = output_dir() / f"{safe_name}.mp4"

    job = _new_job("splice")

    def run() -> None:
        try:
            job.status = "running"
            cb = _progress_for(job)
            splice_render(
                specs,
                out,
                target_width=req.target_width,
                target_height=req.target_height,
                target_fps=req.target_fps,
                encoder=req.encoder,
                audio_bitrate=req.audio_bitrate,
                progress=cb,
            )
            size = out.stat().st_size

            # Record the render in the project's history so the UI's
            # Project Files panel + Ask Cadence can see it.
            if project and render_id:
                rel = out.relative_to(
                    _projects_mod.project_dir_path(project.slug)
                ).as_posix()
                project.render_history.append(
                    _projects_mod.RenderHistoryEntry(
                        id=render_id,
                        type="splice_render",
                        source=None,
                        input_render_id=None,
                        settings={
                            "clips": [c.model_dump() for c in req.clips],
                            "target_width": req.target_width,
                            "target_height": req.target_height,
                            "target_fps": req.target_fps,
                            "encoder": req.encoder,
                            "audio_bitrate": req.audio_bitrate,
                        },
                        output=rel,
                        label=f"splice · {len(req.clips)} clips",
                        timestamp=datetime.now(timezone.utc).isoformat(
                            timespec="seconds"
                        ),
                        size_bytes=size,
                    )
                )
                _projects_mod.save_project(project)

            job.finish(
                "done",
                result={
                    "output_path": str(out),
                    "output_name": out.name,
                    "size_bytes": size,
                    "render_id": render_id,
                    "project_slug": project.slug if project else None,
                },
            )
        except (RenderError, Exception) as e:
            job.finish("error", error=str(e))

    _executor.submit(run)
    return JobHandle(job_id=job.id)


# ─── Ask Cadence (natural-language editing) ─────────────────────────────────


from . import cadence as _cadence_mod  # noqa: E402


class CadenceTurn(BaseModel):
    role: Literal["user", "assistant"]
    text: str


class CadenceQueryRequest(BaseModel):
    message: str
    history: list[CadenceTurn] = []
    project_slug: str
    active_source_rel: str | None = None
    digest_text: str  # frontend builds the digest (it has session state)


class ProposedActionResponse(BaseModel):
    type: str
    summary: str
    params: dict[str, Any]


class CadenceQueryResponse(BaseModel):
    text: str
    actions: list[ProposedActionResponse]
    input_tokens: int
    output_tokens: int


@app.post("/cadence/query", response_model=CadenceQueryResponse)
def cadence_query(req: CadenceQueryRequest) -> CadenceQueryResponse:
    """Single turn of the Ask Cadence conversation.

    Loads the project, hands off to ``cadence.query`` which runs Claude
    with the tool-use loop, and returns the assistant's text plus any
    proposed actions the user can apply via the frontend dispatcher.
    """
    try:
        project = _projects_mod.load_project(req.project_slug)
    except _projects_mod.ProjectNotFound as e:
        raise HTTPException(404, str(e))

    history = [
        _cadence_mod.CadenceMessage(role=t.role, text=t.text)
        for t in req.history
    ]
    try:
        resp = _cadence_mod.query(
            message=req.message,
            history=history,
            project=project,
            active_source_rel=req.active_source_rel,
            digest_text=req.digest_text,
        )
    except RuntimeError as e:
        # Missing API key, etc — surface as 503.
        raise HTTPException(503, str(e))

    return CadenceQueryResponse(
        text=resp.text,
        actions=[
            ProposedActionResponse(type=a.type, summary=a.summary, params=a.params)
            for a in resp.actions
        ],
        input_tokens=resp.input_tokens,
        output_tokens=resp.output_tokens,
    )


# ─── Job introspection ───────────────────────────────────────────────────────


class JobStatusResponse(BaseModel):
    id: str
    kind: str
    status: JobStatus
    progress: float
    message: str
    result: dict[str, Any] | None
    error: str | None


@app.get("/jobs/{job_id}", response_model=JobStatusResponse)
def get_job(job_id: str) -> JobStatusResponse:
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    return JobStatusResponse(
        id=job.id,
        kind=job.kind,
        status=job.status,
        progress=job.progress,
        message=job.message,
        result=job.result,
        error=job.error,
    )


@app.get("/jobs/{job_id}/events")
async def stream_job_events(job_id: str) -> StreamingResponse:
    """SSE stream of job progress events.

    Replays history first (so a late subscriber sees everything), then
    blocks on the job's condition variable until each new event arrives,
    then breaks on the terminal event.
    """
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")

    async def event_stream():
        seen = 0
        # Replay everything that's already happened.
        while seen < len(job.events):
            yield f"data: {json.dumps(job.events[seen])}\n\n"
            seen += 1
            if job.events[seen - 1].get("_terminal"):
                return
        # Then wait for new events. We poll the condition with a short
        # timeout so the SSE connection can be cleanly closed by the client.
        loop = asyncio.get_event_loop()
        while True:
            def wait_for_new() -> bool:
                with job._cv:
                    return job._cv.wait_for(
                        lambda: len(job.events) > seen, timeout=0.5,
                    )
            got_new = await loop.run_in_executor(None, wait_for_new)
            if got_new:
                while seen < len(job.events):
                    ev = job.events[seen]
                    yield f"data: {json.dumps(ev)}\n\n"
                    seen += 1
                    if ev.get("_terminal"):
                        return

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# ─── Media endpoints ─────────────────────────────────────────────────────────


def _resolve_output_file(name: str) -> Path:
    """Path-traversal-safe lookup inside the configured output directory."""
    out = output_dir()
    target = (out / name).resolve()
    if not str(target).startswith(str(out.resolve())):
        raise HTTPException(403, "path escapes output directory")
    if not target.exists():
        raise HTTPException(404, f"file not found: {name}")
    return target


@app.get("/files/{name:path}")
def serve_output_file(name: str) -> FileResponse:
    """Serve any file in the configured output directory.

    Used by the frontend's <video> and <audio> elements to play the rendered
    MP4 and the mic WAV. Restricted to ``output_dir()`` for safety.
    """
    target = _resolve_output_file(name)
    return FileResponse(target)


class UploadResponse(BaseModel):
    path: str
    size_bytes: int


@app.post("/upload", response_model=UploadResponse)
async def upload_file(file: UploadFile = File(...)) -> UploadResponse:
    """Stream an uploaded video into a fresh per-source project directory.

    For ``recording.mov`` this writes to ``<output_dir>/recording/recording.mov``,
    so the upload itself bootstraps the project dir that subsequent pipeline
    stages (analyze / classify / plan / render) will fill out.

    Writes to a temp filename first, then renames on success — partial files
    from a failed/aborted upload don't pollute the project dir. Chunk size
    chosen to balance copy overhead vs memory footprint for multi-GB files.

    Once Tauri wraps this app, the frontend will use the native file dialog
    to get a path directly (zero upload). For browser dev mode and any future
    web deployment, this endpoint is the path through.
    """
    if not file.filename:
        raise HTTPException(400, "upload requires a filename")
    # Uploads land in a cache "uploads" dir, NOT in files/. They're a
    # transient staging spot: the frontend immediately calls
    # POST /projects/<slug>/sources to copy/reference into the active
    # project, after which the temp can be cleaned at will. Using cache_dir
    # also means uploads survive a `rm -rf files/`.
    dest_dir = cache_dir() / "uploads"
    dest_dir.mkdir(parents=True, exist_ok=True)
    final = dest_dir / file.filename
    tmp = dest_dir / f".{file.filename}.upload"

    CHUNK = 8 * 1024 * 1024  # 8 MB — empirically fast enough; memory OK
    try:
        with tmp.open("wb") as fh:
            while True:
                chunk = await file.read(CHUNK)
                if not chunk:
                    break
                fh.write(chunk)
        tmp.replace(final)  # atomic on POSIX
    except Exception:
        tmp.unlink(missing_ok=True)
        raise

    return UploadResponse(path=str(final), size_bytes=final.stat().st_size)


@app.get("/source")
def serve_source(path: str = Query(..., description="Absolute path to source video")) -> FileResponse:
    """Stream a source video for the frontend ``<video>`` element.

    Unlike ``/files/{name}`` (which restricts to ``output_dir()``), this serves
    any file the user explicitly loaded as a media source. For a single-user
    desktop sidecar that's the right tradeoff — the user picked the file, we
    just need to play it back.

    FastAPI's ``FileResponse`` supports HTTP range requests automatically,
    which is what ``<video>`` uses to seek without downloading the whole file.
    """
    src = Path(path).expanduser()
    if not src.exists():
        raise HTTPException(404, f"source not found: {src}")
    if not src.is_file():
        raise HTTPException(400, "not a file")
    return FileResponse(src)


_AUDIO_EXTS = {".wav", ".flac", ".aiff", ".aif", ".mp3", ".ogg"}
_PEAKS_LOCK = threading.Lock()


def _ensure_decodable_audio(input_path: Path) -> Path:
    """If the input is already an audio file, return it as-is. If it's a
    video, extract the audio to the canonical mic-WAV location (16 kHz mono
    PCM) and cache it there so subsequent requests are instant and the
    probe endpoint surfaces it as ``mic_wav_exists``.
    """
    ext = input_path.suffix.lower()
    if ext in _AUDIO_EXTS:
        return input_path
    # It's a video. Cache the extracted WAV at the canonical mic-wav path so
    # this stays consistent with what ingest would have produced anyway.
    out = mic_wav_path(input_path)
    with _PEAKS_LOCK:
        if not out.exists():
            subprocess.run(
                [
                    "ffmpeg", "-y", "-v", "error",
                    "-i", str(input_path),
                    "-vn",
                    "-ac", "1",
                    "-ar", "16000",
                    "-c:a", "pcm_s16le",
                    str(out),
                ],
                check=True, capture_output=True,
            )
    return out


@app.get("/audio-peaks")
def audio_peaks(
    audio_path: str = Query(..., description="Absolute path to source audio OR video"),
    bins: int = Query(2000, ge=100, le=10000, description="Number of downsampled peaks to return"),
) -> dict:
    """Return downsampled amplitude peaks for waveform rendering.

    Wavesurfer.js can render a waveform from a precomputed peaks array
    instead of downloading and decoding the audio itself — huge win for long
    files (a 36-min mic WAV is ~70 MB, vs. ~16 KB of peaks JSON).

    If the input is a video file, audio is auto-extracted to the canonical
    mic-WAV location first and cached. So this endpoint works against any
    media file the user has loaded, regardless of whether they've run the
    full analyze pipeline yet.

    Algorithm: load the audio into a numpy array, split into ``bins`` equal
    chunks, take the max absolute amplitude of each chunk. Returns floats in [0, 1].
    """
    import numpy as np
    import soundfile as sf

    raw_input = Path(audio_path).expanduser()
    if not raw_input.exists():
        raise HTTPException(404, f"input not found: {raw_input}")
    try:
        src = _ensure_decodable_audio(raw_input)
        samples, sample_rate = sf.read(str(src), dtype="float32", always_2d=False)
    except Exception as e:
        raise HTTPException(500, f"could not decode audio: {e}") from e

    if samples.ndim > 1:  # collapse to mono if multi-channel
        samples = samples.mean(axis=1)

    if len(samples) == 0:
        return {"peaks": [], "duration": 0.0, "sample_rate": int(sample_rate), "bins": bins}

    # Downsample to `bins` peaks. We use numpy's array_split (handles
    # non-evenly-divisible lengths) plus np.abs().max() per chunk.
    chunks = np.array_split(samples, bins)
    peaks = [float(np.abs(c).max()) if len(c) > 0 else 0.0 for c in chunks]
    duration = len(samples) / float(sample_rate)
    return {
        "peaks": peaks,
        "duration": duration,
        "sample_rate": int(sample_rate),
        "bins": len(peaks),
    }


_THUMB_LOCK = threading.Lock()


@app.get("/thumbnails")
def thumbnails(
    source_path: str = Query(..., description="Absolute path to source video"),
    count: int = Query(60, ge=8, le=200, description="Number of frames in the sprite"),
    height: int = Query(60, ge=24, le=200, description="Thumbnail height in pixels (width scales by aspect)"),
) -> dict:
    """Generate (and cache) a horizontal sprite sheet of evenly-spaced frames.

    Strategy:
    - One sprite PNG per source, cached in the project's output dir under
      ``<stem>.thumbs.<count>x<height>.png`` so re-fetches are free.
    - ffmpeg ``select`` + ``scale`` + ``tile`` filter chain extracts N
      frames at equal time intervals and arranges them in a 1-row strip.
    - Returns the served URL + dimensions so the frontend can lay the strip
      across the timeline as a CSS background.
    """
    src = Path(source_path).expanduser()
    if not src.exists():
        raise HTTPException(404, f"source not found: {src}")

    # Cache outside of any project dir — sprites are regenerable from the
    # source video, keyed by sha256 of the absolute source path so two files
    # with the same basename can't share an entry.
    sprite, width_meta = thumbnail_cache_path(src, count, height)

    with _THUMB_LOCK:
        if not sprite.exists() or not width_meta.exists():
            # We need the video duration to compute the frame interval.
            probe_data = subprocess.run(
                [
                    "ffprobe", "-v", "error", "-print_format", "json",
                    "-show_entries", "format=duration:stream=width,height,r_frame_rate",
                    "-select_streams", "v:0",
                    str(src),
                ],
                check=True, capture_output=True, text=True,
            ).stdout
            meta = json.loads(probe_data)
            duration = float(meta["format"]["duration"])
            src_w = int(meta["streams"][0]["width"])
            src_h = int(meta["streams"][0]["height"])
            thumb_w = int(round(height * src_w / src_h))

            # `fps=1/N` extracts a frame every N seconds. We pick N so we get
            # exactly `count` frames (then `tile` arranges them horizontally).
            interval = max(duration / count, 0.001)

            tmp = sprite.with_suffix(".tmp.png")
            subprocess.run(
                [
                    "ffmpeg", "-y", "-v", "error",
                    "-i", str(src),
                    "-vf", f"fps=1/{interval:.6f},scale={thumb_w}:{height},tile={count}x1",
                    "-frames:v", "1",
                    "-update", "1",
                    str(tmp),
                ],
                check=True, capture_output=True,
            )
            tmp.replace(sprite)
            width_meta.write_text(json.dumps({
                "count": count,
                "thumb_width": thumb_w,
                "thumb_height": height,
                "sprite_width": thumb_w * count,
                "sprite_height": height,
                "source_duration": duration,
            }))

    meta = json.loads(width_meta.read_text())
    # Sprite lives under cache_dir/thumbs/<key>.png — served by the
    # /cache/thumbs/{name} endpoint below.
    return {
        "url": f"/cache/thumbs/{sprite.name}",
        **meta,
    }


@app.get("/cache/thumbs/{name}")
def get_cached_thumb(name: str) -> FileResponse:
    """Serve a cached thumbnail sprite from ``cache_dir()/thumbs/``.

    Filenames in the cache are sha256-derived so the user can't path-
    traverse out of the directory, but we still resolve + bounds-check
    defensively in case that assumption ever loosens.
    """
    if "/" in name or ".." in name or name.startswith("."):
        raise HTTPException(400, "bad cache name")
    base = (cache_dir() / "thumbs").resolve()
    target = (base / name).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        raise HTTPException(400, "bad cache name")
    if not target.exists():
        raise HTTPException(404, "cache miss")
    return FileResponse(target)


@app.get("/audio-clip")
def audio_clip(
    audio_path: str = Query(..., description="Absolute path to source audio"),
    start: float = Query(..., ge=0.0),
    end: float = Query(..., gt=0.0),
    pad: float = Query(1.5, ge=0.0, le=10.0),
) -> Response:
    """Return an MP3 clip around [start, end] for the per-cut review playback.

    Source must be a file already on disk (typically the mic WAV from ingest).
    The frontend uses this for the review panel — small, fast, cacheable.
    """
    src = Path(audio_path).expanduser()
    if not src.exists():
        raise HTTPException(404, f"audio not found: {src}")
    if end <= start:
        raise HTTPException(400, "end must be > start")
    try:
        mp3 = extract_audio_clip(src, start, end, pad_seconds=pad)
    except Exception as e:
        raise HTTPException(500, f"extraction failed: {e}") from e
    return Response(
        content=mp3,
        media_type="audio/mpeg",
        headers={
            # These clips are deterministic for a given (path, start, end, pad);
            # safe to cache aggressively in the browser.
            "Cache-Control": "public, max-age=3600",
        },
    )


# ─── Convenience: load whole bundles via GET ─────────────────────────────────


@app.get("/analysis", response_model=AnalysisBundle)
def get_analysis(path: str = Query(...)) -> AnalysisBundle:
    p = Path(path).expanduser()
    if not p.exists():
        raise HTTPException(404, f"analysis not found: {p}")
    return AnalysisBundle.model_validate_json(p.read_text())


@app.get("/classification", response_model=ClassificationBundle)
def get_classification(path: str = Query(...)) -> ClassificationBundle:
    p = Path(path).expanduser()
    if not p.exists():
        raise HTTPException(404, f"classification not found: {p}")
    return ClassificationBundle.model_validate_json(p.read_text())


@app.get("/plan-bundle", response_model=CutPlan)
def get_plan(path: str = Query(...)) -> CutPlan:
    p = Path(path).expanduser()
    if not p.exists():
        raise HTTPException(404, f"plan not found: {p}")
    return CutPlan.model_validate_json(p.read_text())
