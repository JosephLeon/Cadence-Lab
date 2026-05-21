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

from video_editor.ingest import IngestError, ingest, probe
from video_editor.models import AnalysisBundle, SourceProbe
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
