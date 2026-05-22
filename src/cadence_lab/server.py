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
│  │  - localhost:8765                 │  │
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
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
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
    Classification,
    ClassificationBundle,
    CutPlan,
    CutPlanParams,
    SourceProbe,
)
from .paths import (
    analysis_path,
    classified_path,
    output_dir,
    plan_path,
    rendered_path,
)
from .planner import plan_cuts
from .renderer import RenderError, render as run_render
from .reviewer import apply_overrides, extract_audio_clip
from .speech import analyze as run_analyze


# ─── Job tracking ────────────────────────────────────────────────────────────


JobStatus = Literal["pending", "running", "done", "error"]


@dataclass
class Job:
    """One async pipeline run. Thread-safe via the GIL for our simple usage."""

    id: str
    kind: Literal["analyze", "classify", "render"]
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


def _new_job(kind: Literal["analyze", "classify", "render"]) -> Job:
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
    analysis_exists: bool
    classified_exists: bool
    plan_exists: bool
    rendered_exists: bool


class ProbeResponse(BaseModel):
    source: SourceProbe
    paths: CanonicalPaths


def _canonical_paths(source: Path) -> CanonicalPaths:
    ap = analysis_path(source)
    cp = classified_path(source)
    pp = plan_path(source)
    rp = rendered_path(source)
    return CanonicalPaths(
        analysis=str(ap),
        classified=str(cp),
        plan=str(pp),
        rendered=str(rp),
        analysis_exists=ap.exists(),
        classified_exists=cp.exists(),
        plan_exists=pp.exists(),
        rendered_exists=rp.exists(),
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


class PlanRequest(BaseModel):
    analysis_path: str
    classified_path: str | None = None  # default: derive from output_dir
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

    plan = plan_cuts(
        speech=bundle.speech,
        classification_bundle=cls_bundle,
        params=CutPlanParams(
            crossfade_ms=req.crossfade_ms,
            filler_pad_ms=req.filler_pad_ms,
            default_breath_ms=req.default_breath_ms,
            min_keep_ms=req.min_keep_ms,
        ),
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


class RenderRequest(BaseModel):
    analysis_path: str
    plan_path: str | None = None  # default: derive from output_dir
    audio_track: int | None = None
    encoder: Literal["auto", "h264_videotoolbox", "libx264"] = "auto"
    audio_bitrate: str = "192k"


@app.post("/render", response_model=JobHandle)
def render_endpoint(req: RenderRequest) -> JobHandle:
    ap = Path(req.analysis_path).expanduser()
    if not ap.exists():
        raise HTTPException(404, f"analysis not found: {ap}")
    bundle = AnalysisBundle.model_validate_json(ap.read_text())

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

    track = (
        req.audio_track
        if req.audio_track is not None
        else bundle.ingest.mic_track_index
    )
    out = rendered_path(src)

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
                progress=cb,
            )
            job.finish(
                "done",
                result={
                    "rendered_path": str(out),
                    "size_bytes": out.stat().st_size,
                },
            )
        except (RenderError, Exception) as e:
            job.finish("error", error=str(e))

    _executor.submit(run)
    return JobHandle(job_id=job.id)


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
    """Stream an uploaded video to the configured output directory.

    Writes to a temp filename first, then renames on success — partial files
    from a failed/aborted upload don't pollute the output dir. Chunk size
    chosen to balance copy overhead vs memory footprint for multi-GB files.

    Once Tauri wraps this app, the frontend will use the native file dialog
    to get a path directly (zero upload). For browser dev mode and any future
    web deployment, this endpoint is the path through.
    """
    if not file.filename:
        raise HTTPException(400, "upload requires a filename")
    out = output_dir()
    final = out / file.filename
    tmp = out / f".{file.filename}.upload"

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
