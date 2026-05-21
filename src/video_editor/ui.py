"""Streamlit UI for the AI Video Editor.

Run via `video-editor ui` (the CLI shells out to `streamlit run`). The UI is a
thin wrapper over the same `probe` and `analyze` functions the CLI uses —
nothing about the pipeline lives here, only display + form state.

Three panels, top to bottom:

1. **Source**     — upload a file or point at a path on disk. Big OBS files
                    should use the path option; upload is for convenience.
2. **Probe**      — table of audio tracks. Pick the mic track index here.
3. **Analyze**    — model + compute-type controls, run button, results, and a
                    download button for the JSON bundle.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import streamlit as st
from dotenv import load_dotenv

from video_editor.classifier import classify as run_classify
from video_editor.ingest import IngestError, ingest, probe
from video_editor.models import (
    AnalysisBundle,
    ClassificationBundle,
    CutPlan,
    CutPlanParams,
    SourceProbe,
)
from video_editor.planner import plan_cuts
from video_editor.renderer import RenderError, render as run_render
from video_editor.reviewer import apply_overrides, extract_audio_clip
from video_editor.speech import analyze

load_dotenv()

st.set_page_config(page_title="AI Video Editor", page_icon="🎬", layout="wide")

# Persistent state across reruns — Streamlit reruns the whole script on every
# interaction, so anything we want to survive lives in session_state.
_DEFAULTS: dict[str, object] = {
    "source_path": None,        # Path | None
    "probe": None,              # SourceProbe | None
    "analysis_bundle": None,    # AnalysisBundle | None
    "analysis_json_path": None, # Path | None
    "classification_bundle": None,  # ClassificationBundle | None
    "classification_json_path": None,  # Path | None
    "cut_plan": None,                # CutPlan | None
    "plan_json_path": None,          # Path | None
    "rendered_path": None,           # Path | None
    # Review state ───────────────────────────────────────────────────────────
    # User overrides on classifier decisions: {(kind, source_id): override_value}
    "classification_overrides": {},  # dict[tuple[str, int], str]
    "review_page": 0,
    "review_filter": "All non-keep",
    "review_show_keeps": False,
}
for k, v in _DEFAULTS.items():
    st.session_state.setdefault(k, v)


def _save_upload(uploaded) -> Path:
    """Persist an uploaded file under a per-session temp dir."""
    upload_dir = Path(tempfile.gettempdir()) / "video_editor_uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    dest = upload_dir / uploaded.name
    with dest.open("wb") as f:
        f.write(uploaded.getbuffer())
    return dest


def _reset_downstream() -> None:
    """Whenever the source changes, throw out any previous probe / analysis."""
    st.session_state.probe = None
    st.session_state.analysis_bundle = None
    st.session_state.analysis_json_path = None
    st.session_state.classification_bundle = None
    st.session_state.classification_json_path = None
    st.session_state.cut_plan = None
    st.session_state.plan_json_path = None
    st.session_state.rendered_path = None
    st.session_state.classification_overrides = {}
    st.session_state.review_page = 0


def _render_probe(p: SourceProbe) -> None:
    cols = st.columns(4)
    cols[0].metric("Duration", f"{p.duration_seconds:.1f}s")
    cols[1].metric("Resolution", f"{p.width}×{p.height}" if p.width else "—")
    cols[2].metric("Frame rate", f"{p.frame_rate:.2f}" if p.frame_rate else "—")
    cols[3].metric("Audio tracks", str(len(p.audio_tracks)))

    if p.is_variable_frame_rate:
        st.warning(
            "Source has a **variable frame rate**. Cuts will need CFR "
            "normalization before render (handled in a later stage)."
        )

    st.subheader("Audio tracks")
    st.dataframe(
        [
            {
                "idx": t.index,
                "codec": t.codec,
                "channels": t.channels,
                "sample rate": t.sample_rate,
                "language": t.language or "—",
                "title": t.title or "—",
                "duration": (
                    f"{t.duration_seconds:.1f}s" if t.duration_seconds else "—"
                ),
            }
            for t in p.audio_tracks
        ],
        use_container_width=True,
        hide_index=True,
    )


def _render_analysis(bundle: AnalysisBundle) -> None:
    speech = bundle.speech
    word_count = sum(len(s.words) for s in speech.segments)

    cols = st.columns(4)
    cols[0].metric("Language", f"{speech.language} ({speech.language_probability:.2f})")
    cols[1].metric("Whisper segments", str(len(speech.segments)))
    cols[2].metric("Words", str(word_count))
    cols[3].metric("VAD speech regions", str(len(speech.vad_segments)))

    tabs = st.tabs(["Transcript", "VAD regions", "Raw JSON"])

    with tabs[0]:
        for seg in speech.segments:
            with st.expander(
                f"[{seg.start:7.2f} → {seg.end:7.2f}]  {seg.text.strip()[:120]}"
            ):
                st.write(seg.text)
                if seg.words:
                    st.dataframe(
                        [
                            {
                                "word": w.text,
                                "start": round(w.start, 3),
                                "end": round(w.end, 3),
                                "prob": round(w.probability, 3) if w.probability else None,
                            }
                            for w in seg.words
                        ],
                        use_container_width=True,
                        hide_index=True,
                    )

    with tabs[1]:
        st.dataframe(
            [
                {
                    "start": round(v.start, 3),
                    "end": round(v.end, 3),
                    "duration": round(v.end - v.start, 3),
                }
                for v in speech.vad_segments
            ],
            use_container_width=True,
            hide_index=True,
        )

    with tabs[2]:
        st.json(bundle.model_dump(mode="json"), expanded=False)


# ─── Layout ────────────────────────────────────────────────────────────────────

st.title("🎬 AI Video Editor")
st.caption("Stage 1 — ingest + speech analysis")

# ─── 1. Source ────────────────────────────────────────────────────────────────
st.header("1. Source")
src_tab_upload, src_tab_path = st.tabs(["Upload file", "Path on disk"])

with src_tab_upload:
    uploaded = st.file_uploader(
        "Drop a video file",
        type=["mov", "mp4", "mkv", "m4v", "avi", "webm"],
        help="OBS recordings often run multiple GB. For large files, use the 'Path on disk' tab instead.",
    )
    if uploaded is not None:
        path = _save_upload(uploaded)
        if st.session_state.source_path != path:
            _reset_downstream()
            st.session_state.source_path = path
        st.success(f"Loaded `{path}`")

with src_tab_path:
    raw_path = st.text_input(
        "Absolute path to a video file",
        value=str(st.session_state.source_path or ""),
        placeholder="/Users/you/Recordings/episode-12.mov",
    )
    if raw_path:
        p = Path(raw_path).expanduser()
        if not p.exists():
            st.error(f"No file at `{p}`")
        elif st.session_state.source_path != p.resolve():
            _reset_downstream()
            st.session_state.source_path = p.resolve()
            st.success(f"Loaded `{p}`")

# ─── 2. Probe ─────────────────────────────────────────────────────────────────
if st.session_state.source_path is not None:
    st.header("2. Probe")
    if st.session_state.probe is None:
        try:
            with st.spinner("Probing source with ffprobe..."):
                st.session_state.probe = probe(st.session_state.source_path)
        except IngestError as e:
            st.error(f"Probe failed: {e}")

    if st.session_state.probe is not None:
        _render_probe(st.session_state.probe)

# ─── 3. Analyze ───────────────────────────────────────────────────────────────
if st.session_state.probe is not None:
    st.header("3. Analyze")

    p = st.session_state.probe
    track_options = {
        f"#{t.index} — {t.codec} {t.channels}ch @ {t.sample_rate} ({t.title or '—'})": t.index
        for t in p.audio_tracks
    }

    cfg_left, cfg_right = st.columns(2)
    with cfg_left:
        mic_track_label = st.selectbox(
            "Mic track",
            options=list(track_options.keys()),
            help="OBS records mic + desktop audio as separate tracks. Pick the mic.",
        )
        mic_track = track_options[mic_track_label]

        language = st.text_input(
            "Force language (optional)",
            value="",
            placeholder="en",
            help="ISO 639-1 code. Leave blank to auto-detect.",
        ) or None

    with cfg_right:
        backend = st.selectbox(
            "Transcription backend",
            options=["groq", "local"],
            index=0,
            help=(
                "groq = whisper-large-v3 hosted on Groq (~30× realtime, requires "
                "GROQ_API_KEY). local = faster-whisper on Apple Silicon CPU "
                "(slow, offline)."
            ),
        )
        if backend == "groq":
            if os.getenv("GROQ_API_KEY"):
                st.caption(":green[✓ GROQ_API_KEY detected]")
            else:
                st.warning(
                    "GROQ_API_KEY not set. Add it to `.env` (see `.env.example`) "
                    "and restart, or switch to the local backend."
                )
            model_size = "large-v3"
            compute_type = "int8"  # ignored by groq backend, kept for shape
        else:
            model_size = st.selectbox(
                "Whisper model",
                options=["large-v3", "medium", "small", "base", "tiny"],
                index=0,
                help="large-v3 = best quality, slowest on CPU.",
            )
            compute_type = st.selectbox(
                "Compute precision",
                options=["int8", "int8_float16", "float16", "float32"],
                index=0,
                help="int8 is the practical Apple Silicon CPU default.",
            )

    run = st.button("▶ Run analysis", type="primary")
    if run:
        st.session_state.analysis_bundle = None
        st.session_state.analysis_json_path = None

        work_dir = Path("output/work")
        work_dir.mkdir(parents=True, exist_ok=True)

        # Progress UI: one status line + one progress bar that we drive across
        # the full pipeline (ingest → VAD → transcription). Ingest and VAD are
        # short bursts; Whisper transcription is where real per-segment progress
        # matters, and faster-whisper yields segments incrementally so we get
        # honest 0→100% rather than a guess.
        progress_bar = st.progress(0.0)
        status_line = st.empty()

        def on_progress(frac: float, msg: str) -> None:
            progress_bar.progress(min(max(frac, 0.0), 1.0))
            status_line.markdown(f"**{msg}**")

        try:
            on_progress(0.0, "Extracting mic-only audio...")
            ing = ingest(
                source=st.session_state.source_path,
                work_dir=work_dir,
                mic_track_index=mic_track,
            )

            speech = analyze(
                audio_path=ing.normalized_audio_path,
                backend=backend,
                model_size=model_size,
                compute_type=compute_type,
                language=language,
                progress=on_progress,
            )

            bundle = AnalysisBundle(ingest=ing, speech=speech)
            out_path = st.session_state.source_path.with_suffix(".analysis.json")
            out_path.write_text(json.dumps(bundle.model_dump(mode="json"), indent=2))

            st.session_state.analysis_bundle = bundle
            st.session_state.analysis_json_path = out_path

            progress_bar.progress(1.0)
            status_line.empty()
            st.success(f"Done. Wrote analysis bundle to `{out_path}`")
        except Exception as e:
            progress_bar.empty()
            status_line.empty()
            st.exception(e)

# ─── 4. Results ───────────────────────────────────────────────────────────────
if st.session_state.analysis_bundle is not None:
    st.header("4. Results")
    bundle = st.session_state.analysis_bundle
    _render_analysis(bundle)

    json_blob = json.dumps(bundle.model_dump(mode="json"), indent=2)
    st.download_button(
        "⬇ Download analysis JSON",
        data=json_blob,
        file_name=(st.session_state.analysis_json_path or Path("analysis.json")).name,
        mime="application/json",
    )

# ─── 5. Classify (Stage 3) ────────────────────────────────────────────────────
if st.session_state.analysis_bundle is not None:
    st.header("5. Classify pauses & fillers (Claude)")
    st.caption(
        "Sends the transcript + word-level pauses to Claude Opus 4.7 with a "
        "frozen rubric. Each pause is classified (filler / hesitation / breath / "
        "emphasis / pre-laughter / transition / listening), each candidate "
        "filler word gets cut/keep, and retakes are detected."
    )

    if not os.getenv("ANTHROPIC_API_KEY"):
        st.warning(
            "ANTHROPIC_API_KEY not set. Add it to `.env` (see `.env.example`) "
            "and relaunch."
        )
    else:
        st.caption(":green[✓ ANTHROPIC_API_KEY detected]")

    min_pause_ms = st.slider(
        "Minimum pause (ms) to classify",
        min_value=100, max_value=1000, value=250, step=50,
        help="Gaps between words shorter than this are treated as natural spacing "
             "and skipped.",
    )

    run_cls = st.button(
        "▶ Run classification",
        type="primary",
        disabled=not os.getenv("ANTHROPIC_API_KEY"),
    )

    if run_cls:
        st.session_state.classification_bundle = None
        st.session_state.classification_json_path = None
        # Reclassification invalidates any downstream cut plan AND overrides
        # (the source IDs are about to change).
        st.session_state.cut_plan = None
        st.session_state.plan_json_path = None
        st.session_state.classification_overrides = {}
        st.session_state.review_page = 0

        progress_bar = st.progress(0.0)
        status_line = st.empty()

        def on_cls_progress(frac: float, msg: str) -> None:
            progress_bar.progress(min(max(frac, 0.0), 1.0))
            status_line.markdown(f"**{msg}**")

        try:
            result = run_classify(
                speech=st.session_state.analysis_bundle.speech,
                min_pause_seconds=min_pause_ms / 1000.0,
                progress=on_cls_progress,
            )
        except Exception as e:
            progress_bar.empty()
            status_line.empty()
            st.exception(e)
        else:
            st.session_state.classification_bundle = result
            # Persist alongside the analysis JSON if we have a source path
            if st.session_state.source_path is not None:
                cls_path = st.session_state.source_path.with_suffix(".classified.json")
                cls_path.write_text(
                    json.dumps(result.model_dump(mode="json"), indent=2)
                )
                st.session_state.classification_json_path = cls_path
            progress_bar.progress(1.0)
            status_line.empty()
            st.success("Classification complete.")

# ─── 6. Classification results ────────────────────────────────────────────────
if st.session_state.classification_bundle is not None:
    st.header("6. Classification results")
    cls_bundle: ClassificationBundle = st.session_state.classification_bundle
    cls = cls_bundle.classification

    cut_p = sum(1 for p in cls.pauses if p.action == "cut")
    trim_p = sum(1 for p in cls.pauses if p.action == "trim")
    keep_p = sum(1 for p in cls.pauses if p.action == "keep")
    cut_f = sum(1 for f in cls.fillers if f.action == "cut")

    cols = st.columns(4)
    cols[0].metric("Pauses cut", str(cut_p))
    cols[1].metric("Pauses trimmed", str(trim_p))
    cols[2].metric("Pauses kept", str(keep_p))
    cols[3].metric("Fillers cut", f"{cut_f} / {len(cls.fillers)}")

    cost_cols = st.columns(4)
    cost_cols[0].metric("Retakes", str(len(cls.retakes)))
    cost_cols[1].metric("Input tokens", f"{cls_bundle.input_tokens:,}")
    cost_cols[2].metric("Output tokens", f"{cls_bundle.output_tokens:,}")
    cost_cols[3].metric("Cache read", f"{cls_bundle.cache_read_input_tokens:,}")

    tabs = st.tabs(["Pauses", "Fillers", "Retakes", "Raw JSON"])

    # Build lookup: pause_id -> candidate (for start/end timestamps)
    pause_by_id = {p.id: p for p in cls_bundle.pause_candidates}
    filler_by_id = {f.id: f for f in cls_bundle.filler_candidates}

    with tabs[0]:
        st.dataframe(
            [
                {
                    "id": p.id,
                    "start": round(pause_by_id[p.id].start, 2) if p.id in pause_by_id else None,
                    "dur (s)": round(pause_by_id[p.id].duration, 2) if p.id in pause_by_id else None,
                    "category": p.category,
                    "action": p.action,
                    "trim → ms": p.trim_to_ms,
                    "reason": p.reason,
                }
                for p in cls.pauses
            ],
            use_container_width=True,
            hide_index=True,
        )

    with tabs[1]:
        st.dataframe(
            [
                {
                    "id": f.id,
                    "start": round(filler_by_id[f.id].start, 2) if f.id in filler_by_id else None,
                    "word": filler_by_id[f.id].text if f.id in filler_by_id else "?",
                    "action": f.action,
                    "reason": f.reason,
                }
                for f in cls.fillers
            ],
            use_container_width=True,
            hide_index=True,
        )

    with tabs[2]:
        if not cls.retakes:
            st.caption("No retakes detected.")
        else:
            st.dataframe(
                [
                    {
                        "cut_start": round(r.cut_start, 2),
                        "cut_end": round(r.cut_end, 2),
                        "keep_start": round(r.keep_start, 2),
                        "keep_end": round(r.keep_end, 2),
                        "reason": r.reason,
                    }
                    for r in cls.retakes
                ],
                use_container_width=True,
                hide_index=True,
            )

    with tabs[3]:
        st.json(cls_bundle.model_dump(mode="json"), expanded=False)

    st.download_button(
        "⬇ Download classification JSON",
        data=json.dumps(cls_bundle.model_dump(mode="json"), indent=2),
        file_name=(
            st.session_state.classification_json_path
            or Path("classification.json")
        ).name,
        mime="application/json",
    )

# ─── 7. Plan cuts (Stage 4) ───────────────────────────────────────────────────
if st.session_state.classification_bundle is not None:
    st.header("7. Plan cuts")
    st.caption(
        "Converts the classification into a concrete edit decision list — the "
        "list of source-video time ranges that survive into the final cut. "
        "Pure interval algebra: pause cuts, breath trims, filler cuts, and "
        "retakes get merged, the complement in [0, duration] becomes the keeps."
    )

    pc1, pc2 = st.columns(2)
    with pc1:
        plan_crossfade_ms = st.slider(
            "Crossfade at each cut (ms)",
            min_value=0, max_value=60, value=20, step=5,
            help="Recorded in the plan; applied by the renderer.",
        )
        plan_filler_pad_ms = st.slider(
            "Pad around filler cuts (ms)",
            min_value=0, max_value=80, value=20, step=5,
            help="Buffer on each side of a cut filler to avoid clipping adjacent words.",
        )
    with pc2:
        plan_breath_ms = st.slider(
            "Default breath trim (ms)",
            min_value=80, max_value=300, value=150, step=10,
            help=(
                "Used when the classifier didn't specify trim_to_ms. Keeping ~150ms "
                "of breath preserves natural pacing; cutting fully sounds robotic."
            ),
        )
        plan_min_keep_ms = st.slider(
            "Drop keep-segments shorter than (ms)",
            min_value=0, max_value=200, value=80, step=10,
            help="Sliver keeps from overlapping cuts — inaudible after crossfade.",
        )

    if st.button("▶ Build cut plan", type="primary"):
        params = CutPlanParams(
            crossfade_ms=plan_crossfade_ms,
            filler_pad_ms=plan_filler_pad_ms,
            default_breath_ms=plan_breath_ms,
            min_keep_ms=plan_min_keep_ms,
        )
        try:
            plan = plan_cuts(
                speech=st.session_state.analysis_bundle.speech,
                classification_bundle=st.session_state.classification_bundle,
                params=params,
            )
        except Exception as e:
            st.exception(e)
        else:
            st.session_state.cut_plan = plan
            if st.session_state.source_path is not None:
                plan_path = st.session_state.source_path.with_suffix(".plan.json")
                plan_path.write_text(
                    json.dumps(plan.model_dump(mode="json"), indent=2)
                )
                st.session_state.plan_json_path = plan_path
            st.success("Cut plan built.")

# ─── 8. Plan results ──────────────────────────────────────────────────────────
if st.session_state.cut_plan is not None:
    st.header("8. Plan results")
    plan: CutPlan = st.session_state.cut_plan

    cuts_by_kind: dict[str, list] = {}
    removed_by_kind: dict[str, float] = {}
    for c in plan.cuts:
        cuts_by_kind.setdefault(c.kind, []).append(c)
        removed_by_kind[c.kind] = removed_by_kind.get(c.kind, 0.0) + c.duration_removed

    top = st.columns(4)
    top[0].metric("Source", f"{plan.source_duration:.1f}s")
    top[1].metric("Output", f"{plan.output_duration:.1f}s")
    top[2].metric(
        "Time saved",
        f"{plan.time_saved_seconds:.1f}s",
        delta=f"-{plan.time_saved_pct:.1f}%",
        delta_color="inverse",
    )
    top[3].metric("Keep segments", str(len(plan.keeps)))

    breakdown = st.columns(4)
    for col, kind in zip(
        breakdown, ("pause_cut", "pause_trim", "filler_cut", "retake_cut")
    ):
        n = len(cuts_by_kind.get(kind, []))
        s = removed_by_kind.get(kind, 0.0)
        col.metric(kind.replace("_", " "), f"{n} ops", f"{s:.1f}s removed")

    tabs = st.tabs(["Keep segments", "Cut log", "Raw JSON"])

    with tabs[0]:
        st.dataframe(
            [
                {
                    "#": i,
                    "source_start": round(k.source_start, 2),
                    "source_end": round(k.source_end, 2),
                    "duration (s)": round(k.duration, 2),
                }
                for i, k in enumerate(plan.keeps)
            ],
            use_container_width=True,
            hide_index=True,
        )

    with tabs[1]:
        st.dataframe(
            [
                {
                    "start": round(c.source_start, 2),
                    "end": round(c.source_end, 2),
                    "removed (ms)": int(c.duration_removed * 1000),
                    "kind": c.kind,
                    "reason": c.reason,
                }
                for c in sorted(plan.cuts, key=lambda c: c.source_start)
            ],
            use_container_width=True,
            hide_index=True,
        )

    with tabs[2]:
        st.json(plan.model_dump(mode="json"), expanded=False)

    st.download_button(
        "⬇ Download plan JSON",
        data=json.dumps(plan.model_dump(mode="json"), indent=2),
        file_name=(st.session_state.plan_json_path or Path("plan.json")).name,
        mime="application/json",
    )

# ─── 9. Review & refine (Stage 6) ─────────────────────────────────────────────
# Per-cut review with inline audio. User decisions get stored in
# session_state.classification_overrides keyed by (kind, source_id); clicking
# "Apply changes" re-runs the planner with apply_overrides() and refreshes the
# plan in place. Pagination keeps the page responsive on long videos with
# hundreds of cuts.
REVIEW_PAGE_SIZE = 20


@st.cache_data(show_spinner=False, max_entries=512)
def _cached_audio_clip(audio_path: str, start: float, end: float, pad: float) -> bytes:
    """st.cache_data wrapper around the reviewer's clip extractor."""
    return extract_audio_clip(Path(audio_path), start, end, pad_seconds=pad)


def _context_around(
    words, start: float, end: float, before: int = 6, after: int = 6,
) -> tuple[str, str, str]:
    """Pull the few words just before / inside / after a time range."""
    before_words = [w for w in words if w.end <= start + 0.001]
    in_words = [w for w in words if w.start >= start - 0.001 and w.end <= end + 0.001]
    after_words = [w for w in words if w.start >= end - 0.001]
    return (
        " ".join(w.text.strip() for w in before_words[-before:]),
        " ".join(w.text.strip() for w in in_words),
        " ".join(w.text.strip() for w in after_words[:after]),
    )


def _fmt_clock(s: float) -> str:
    m, sec = divmod(int(s), 60)
    return f"{m:02d}:{sec:02d}"


def _review_row_pause(p, cand, words, audio_path: Path) -> None:
    """One expandable review row for a classified pause."""
    key = ("pause", p.id)
    current = st.session_state.classification_overrides.get(key, p.action)
    icon = {"cut": "✂️", "trim": "✂︎", "keep": "•"}[current]
    overridden = " ⟵ overridden" if key in st.session_state.classification_overrides else ""
    with st.expander(
        f"{icon}  [{_fmt_clock(cand.start)}]  pause {cand.duration*1000:.0f}ms  "
        f"— {p.category}: {p.reason}{overridden}"
    ):
        before, _, after = _context_around(words, cand.start, cand.end)
        st.caption(f"…{before}  ▎{cand.duration*1000:.0f}ms pause▎  {after}…")
        try:
            audio = _cached_audio_clip(str(audio_path), cand.start, cand.end, 1.5)
            st.audio(audio, format="audio/mp3")
        except Exception as e:
            st.caption(f"_audio unavailable: {e}_")
        choice = st.radio(
            "Action",
            options=["cut", "trim", "keep"],
            index=["cut", "trim", "keep"].index(current),
            horizontal=True,
            key=f"action_pause_{p.id}",
            label_visibility="collapsed",
        )
        if choice != p.action:
            st.session_state.classification_overrides[key] = choice
        elif key in st.session_state.classification_overrides:
            del st.session_state.classification_overrides[key]


def _review_row_filler(f, cand, words, audio_path: Path) -> None:
    key = ("filler", f.id)
    current = st.session_state.classification_overrides.get(key, f.action)
    icon = {"cut": "✂️", "keep": "•"}[current]
    overridden = " ⟵ overridden" if key in st.session_state.classification_overrides else ""
    with st.expander(
        f"{icon}  [{_fmt_clock(cand.start)}]  filler “{cand.text}”  — {f.reason}{overridden}"
    ):
        before, hit, after = _context_around(words, cand.start, cand.end, before=8, after=8)
        st.caption(f"…{before}  ▎{hit or cand.text}▎  {after}…")
        try:
            audio = _cached_audio_clip(str(audio_path), cand.start, cand.end, 1.0)
            st.audio(audio, format="audio/mp3")
        except Exception as e:
            st.caption(f"_audio unavailable: {e}_")
        choice = st.radio(
            "Action",
            options=["cut", "keep"],
            index=["cut", "keep"].index(current),
            horizontal=True,
            key=f"action_filler_{f.id}",
            label_visibility="collapsed",
        )
        if choice != f.action:
            st.session_state.classification_overrides[key] = choice
        elif key in st.session_state.classification_overrides:
            del st.session_state.classification_overrides[key]


def _review_row_retake(idx: int, r, words, audio_path: Path) -> None:
    key = ("retake", idx)
    current = st.session_state.classification_overrides.get(key, "accept")
    icon = "✂️" if current == "accept" else "•"
    overridden = " ⟵ overridden" if key in st.session_state.classification_overrides else ""
    cut_dur = (r.cut_end - r.cut_start) * 1000
    with st.expander(
        f"{icon}  [{_fmt_clock(r.cut_start)}]  retake — drop {cut_dur:.0f}ms  "
        f"— {r.reason}{overridden}"
    ):
        # Show transcript for both the cut and keep ranges.
        _, cut_text, _ = _context_around(words, r.cut_start, r.cut_end, before=0, after=0)
        _, keep_text, _ = _context_around(words, r.keep_start, r.keep_end, before=0, after=0)
        st.caption(f"**Cut (first take):**  {cut_text}")
        st.caption(f"**Keep (better take):**  {keep_text}")
        try:
            # Play the cut + keep range together so user can compare both takes.
            audio = _cached_audio_clip(
                str(audio_path), r.cut_start, r.keep_end, 0.5
            )
            st.audio(audio, format="audio/mp3")
        except Exception as e:
            st.caption(f"_audio unavailable: {e}_")
        choice = st.radio(
            "Action",
            options=["accept", "reject"],
            index=["accept", "reject"].index(current),
            horizontal=True,
            key=f"action_retake_{idx}",
            label_visibility="collapsed",
        )
        if choice == "reject":
            st.session_state.classification_overrides[key] = "reject"
        elif key in st.session_state.classification_overrides:
            del st.session_state.classification_overrides[key]


if (
    st.session_state.cut_plan is not None
    and st.session_state.classification_bundle is not None
    and st.session_state.analysis_bundle is not None
):
    st.header("9. Review & refine")
    st.caption(
        "Listen to each proposed cut, override the classifier when it got "
        "something wrong, then **Apply changes** to re-plan. The render in "
        "section 10 picks up the refined plan automatically."
    )

    cls_bundle = st.session_state.classification_bundle
    cls_orig = cls_bundle.classification
    speech = st.session_state.analysis_bundle.speech
    audio_path = st.session_state.analysis_bundle.ingest.normalized_audio_path
    words = speech.words

    pause_by_id = {c.id: c for c in cls_bundle.pause_candidates}
    filler_by_id = {c.id: c for c in cls_bundle.filler_candidates}

    # ── Filter / display controls
    fc1, fc2, fc3 = st.columns([2, 2, 1])
    with fc1:
        filt = st.selectbox(
            "Show",
            options=[
                "All non-keep",
                "Pauses only",
                "Fillers only",
                "Retakes only",
                "My overrides only",
                "Everything",
            ],
            index=0,
            key="review_filter_select",
        )
    with fc2:
        st.metric(
            "Pending overrides",
            str(len(st.session_state.classification_overrides)),
        )
    with fc3:
        if st.button("Reset overrides"):
            st.session_state.classification_overrides = {}
            st.rerun()

    # ── Build the row list (sorted by source start)
    rows: list[tuple[float, str, object, object]] = []
    show_keeps = filt in ("Everything",)

    if filt in ("All non-keep", "Pauses only", "Everything", "My overrides only"):
        for p in cls_orig.pauses:
            cand = pause_by_id.get(p.id)
            if cand is None:
                continue
            if filt == "My overrides only":
                if ("pause", p.id) not in st.session_state.classification_overrides:
                    continue
            elif not show_keeps and p.action == "keep":
                continue
            if filt == "Pauses only" or filt == "All non-keep" or filt == "Everything" or filt == "My overrides only":
                rows.append((cand.start, "pause", p, cand))

    if filt in ("All non-keep", "Fillers only", "Everything", "My overrides only"):
        for f in cls_orig.fillers:
            cand = filler_by_id.get(f.id)
            if cand is None:
                continue
            if filt == "My overrides only":
                if ("filler", f.id) not in st.session_state.classification_overrides:
                    continue
            elif not show_keeps and f.action == "keep":
                continue
            rows.append((cand.start, "filler", f, cand))

    if filt in ("All non-keep", "Retakes only", "Everything", "My overrides only"):
        for i, r in enumerate(cls_orig.retakes):
            if filt == "My overrides only":
                if ("retake", i) not in st.session_state.classification_overrides:
                    continue
            rows.append((r.cut_start, "retake", (i, r), None))

    rows.sort(key=lambda x: x[0])

    if not rows:
        st.info("Nothing to review with the current filter.")
    else:
        # ── Pagination
        total_pages = (len(rows) + REVIEW_PAGE_SIZE - 1) // REVIEW_PAGE_SIZE
        page = min(st.session_state.review_page, max(total_pages - 1, 0))
        page_start = page * REVIEW_PAGE_SIZE
        page_end = min(page_start + REVIEW_PAGE_SIZE, len(rows))

        page_cols = st.columns([1, 4, 1])
        with page_cols[0]:
            if st.button("← Prev", disabled=(page <= 0)):
                st.session_state.review_page = max(0, page - 1)
                st.rerun()
        with page_cols[1]:
            st.caption(
                f"Showing {page_start + 1}–{page_end} of {len(rows)} items   "
                f"(page {page + 1} of {total_pages})"
            )
        with page_cols[2]:
            if st.button("Next →", disabled=(page >= total_pages - 1)):
                st.session_state.review_page = min(total_pages - 1, page + 1)
                st.rerun()

        for _, kind, item, cand in rows[page_start:page_end]:
            if kind == "pause":
                _review_row_pause(item, cand, words, audio_path)
            elif kind == "filler":
                _review_row_filler(item, cand, words, audio_path)
            elif kind == "retake":
                idx, r = item  # type: ignore[misc]
                _review_row_retake(idx, r, words, audio_path)

    # ── Apply changes (re-plan)
    st.divider()
    apply_col, preview_col = st.columns([1, 3])
    with apply_col:
        apply = st.button(
            "▶ Apply changes & re-plan",
            type="primary",
            disabled=(len(st.session_state.classification_overrides) == 0),
        )
    with preview_col:
        # Compute a preview of impact without committing.
        if st.session_state.classification_overrides:
            try:
                modified = apply_overrides(
                    cls_orig, st.session_state.classification_overrides
                )
                preview_plan = plan_cuts(
                    speech,
                    cls_bundle.model_copy(update={"classification": modified}),
                    params=st.session_state.cut_plan.params,
                )
                delta = preview_plan.output_duration - st.session_state.cut_plan.output_duration
                arrow = "↑" if delta > 0 else "↓"
                st.caption(
                    f"Preview: output would be **{preview_plan.output_duration:.1f}s** "
                    f"({arrow}{abs(delta):.1f}s vs current plan)"
                )
            except Exception as e:
                st.caption(f"_preview unavailable: {e}_")

    if apply:
        modified = apply_overrides(
            cls_orig, st.session_state.classification_overrides
        )
        modified_bundle = cls_bundle.model_copy(update={"classification": modified})
        new_plan = plan_cuts(
            speech,
            modified_bundle,
            params=st.session_state.cut_plan.params,
        )
        st.session_state.cut_plan = new_plan
        # Re-save the plan JSON alongside the source.
        if st.session_state.source_path is not None:
            plan_path = st.session_state.source_path.with_suffix(".plan.json")
            plan_path.write_text(
                json.dumps(new_plan.model_dump(mode="json"), indent=2)
            )
            st.session_state.plan_json_path = plan_path
        # An earlier render is now stale.
        st.session_state.rendered_path = None
        st.success(
            f"Re-planned with {len(st.session_state.classification_overrides)} "
            f"override(s) applied. New duration: {new_plan.output_duration:.1f}s."
        )

# ─── 10. Render (Stage 5) ─────────────────────────────────────────────────────
if st.session_state.cut_plan is not None and st.session_state.analysis_bundle is not None:
    st.header("10. Render to MP4")
    st.caption(
        "Executes the cut plan against the source video. libx264 + AAC, "
        "audio fade-in/out at every cut for click-free joins. Slow but quality-first."
    )

    plan_now: CutPlan = st.session_state.cut_plan
    bundle_now = st.session_state.analysis_bundle
    default_track = bundle_now.ingest.mic_track_index
    n_tracks = len(bundle_now.ingest.source.audio_tracks)

    rc1, rc2 = st.columns(2)
    with rc1:
        crf = st.slider(
            "Video quality (CRF)",
            min_value=14, max_value=28, value=18, step=1,
            help="Lower = better quality, bigger file. 18 ≈ visually lossless; "
                 "23 is YouTube default-ish.",
        )
        preset = st.selectbox(
            "Encoder preset (speed vs compression)",
            options=[
                "ultrafast", "superfast", "veryfast", "faster",
                "fast", "medium", "slow", "slower", "veryslow",
            ],
            index=6,  # slow
            help="Slower presets compress more efficiently at the same quality.",
        )
    with rc2:
        audio_bitrate = st.selectbox(
            "Audio bitrate (AAC)",
            options=["128k", "160k", "192k", "256k", "320k"],
            index=2,
        )
        audio_track = st.selectbox(
            "Audio track to render",
            options=list(range(n_tracks)),
            index=min(default_track, n_tracks - 1),
            help=f"Default ({default_track}) is the mic track used for analysis.",
        )

    if st.button("▶ Render MP4", type="primary"):
        source_path = st.session_state.source_path
        out_path = source_path.with_suffix(".edited.mp4")

        progress_bar = st.progress(0.0)
        status_line = st.empty()

        def on_render_progress(frac: float, msg: str) -> None:
            progress_bar.progress(min(max(frac, 0.0), 1.0))
            status_line.markdown(f"**{msg}**")

        try:
            run_render(
                source=source_path,
                plan=plan_now,
                output_path=out_path,
                audio_track_index=audio_track,
                video_crf=crf,
                video_preset=preset,
                audio_bitrate=audio_bitrate,
                progress=on_render_progress,
            )
        except RenderError as e:
            progress_bar.empty()
            status_line.empty()
            st.error(f"Render failed:\n\n```\n{e}\n```")
        except Exception as e:
            progress_bar.empty()
            status_line.empty()
            st.exception(e)
        else:
            st.session_state.rendered_path = out_path
            progress_bar.progress(1.0)
            status_line.empty()
            size_mb = out_path.stat().st_size / 1_048_576
            st.success(f"Rendered {out_path.name} ({size_mb:.1f} MB)")

# ─── 11. Output ───────────────────────────────────────────────────────────────
if st.session_state.rendered_path is not None and st.session_state.rendered_path.exists():
    st.header("11. Output")
    out_path = st.session_state.rendered_path

    size_mb = out_path.stat().st_size / 1_048_576
    out_cols = st.columns(3)
    out_cols[0].metric("File", out_path.name)
    out_cols[1].metric("Size", f"{size_mb:.1f} MB")
    if st.session_state.cut_plan is not None:
        out_cols[2].metric(
            "Duration",
            f"{st.session_state.cut_plan.output_duration:.1f}s",
        )

    st.caption(f"Saved to `{out_path}`")
    # Preview the rendered video. Streamlit streams from disk — fine for moderate sizes.
    st.video(str(out_path))

    with open(out_path, "rb") as f:
        st.download_button(
            "⬇ Download MP4",
            data=f,
            file_name=out_path.name,
            mime="video/mp4",
        )
