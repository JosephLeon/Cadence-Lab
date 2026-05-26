"""Semantic visual search over a source video.

The opt-in indexing pass:
  1. Extracts one frame per second (configurable) from the source
  2. Encodes each frame with CLIP ViT-B/32
  3. Saves embeddings + timestamps as a single ``.npz`` artifact

At query time we encode the text query with the same CLIP, take cosine
similarity against the saved embeddings, and return the top-K timestamps.

Why visual search instead of just transcript search? Two use cases the
transcript can't answer:
  - "Find the B-roll of the walnut table" — visual content with no speech
  - "Find clips where the speaker is laughing" — non-verbal events

For text-only queries the existing transcript + `list_fillers` /
`get_full_transcript` are still faster and more accurate. Cadence picks
the right tool based on the query.
"""

from __future__ import annotations

import io
import subprocess
import threading
from pathlib import Path
from typing import Callable

import numpy as np

ProgressFn = Callable[[float, str], None]


# Frames per second extracted from the source. 1 fps catches scene
# changes for a YouTuber-style video without blowing up the index size.
# A 30-min video at 1 fps = 1,800 embeddings × 512 dims × 4 bytes ≈ 3.6MB.
_FRAMES_PER_SECOND = 1.0

# Target frame dimensions for CLIP. Match the model's expected input so
# resize happens once in ffmpeg, not later in torchvision.
_CLIP_INPUT_SIZE = 224

# Model name + pretrained tag used everywhere. Both encoders share this.
_CLIP_MODEL = "ViT-B-32"
_CLIP_PRETRAINED = "openai"


# Cached singletons.
_MODEL_LOCK = threading.Lock()
_MODEL = None
_PREPROCESS = None
_TOKENIZER = None


def _load_clip(progress: ProgressFn | None = None):
    """Lazy-load the CLIP model + tokenizer. ~150MB checkpoint downloads
    on first run (open_clip handles caching to ``~/.cache/clip/``)."""
    global _MODEL, _PREPROCESS, _TOKENIZER
    if _MODEL is not None:
        return _MODEL, _PREPROCESS, _TOKENIZER
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL, _PREPROCESS, _TOKENIZER
        if progress:
            progress(
                0.05,
                "Loading CLIP model (first run downloads ~150MB)…",
            )
        import open_clip  # type: ignore
        import torch

        model, _, preprocess = open_clip.create_model_and_transforms(
            _CLIP_MODEL, pretrained=_CLIP_PRETRAINED
        )
        model.eval()
        # CPU is fine — single-image inference is ~30ms, batched even faster.
        # Apple's MPS backend would speed this up but adds compatibility
        # surface; defer.
        tokenizer = open_clip.get_tokenizer(_CLIP_MODEL)
        _MODEL = model
        _PREPROCESS = preprocess
        _TOKENIZER = tokenizer
        # Disable gradients globally for inference path.
        for p in model.parameters():
            p.requires_grad_(False)
    return _MODEL, _PREPROCESS, _TOKENIZER


def _extract_frames(
    source_path: Path,
    fps: float = _FRAMES_PER_SECOND,
    size: int = _CLIP_INPUT_SIZE,
):
    """Yield ``(timestamp_seconds, PIL.Image)`` for each sampled frame.

    Pipes raw RGB24 from ffmpeg's image2pipe and decodes lazily so we
    don't materialize the full image stack in memory for long videos.
    """
    from PIL import Image  # transitive via torchvision

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source_path),
        "-vf",
        f"fps={fps},scale={size}:{size}:force_original_aspect_ratio=increase,"
        f"crop={size}:{size}",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = size * size * 3
    frame_idx = 0
    try:
        assert proc.stdout is not None
        while True:
            chunk = proc.stdout.read(frame_bytes)
            if not chunk or len(chunk) < frame_bytes:
                break
            img = Image.frombuffer("RGB", (size, size), chunk, "raw", "RGB", 0, 1)
            ts = frame_idx / fps
            yield ts, img
            frame_idx += 1
    finally:
        try:
            proc.stdout.close()  # type: ignore[union-attr]
        except Exception:
            pass
        proc.wait()
        if proc.returncode not in (0, None):
            tail = (proc.stderr.read() if proc.stderr else b"").decode("utf-8", "replace")
            raise RuntimeError(
                f"ffmpeg failed extracting frames (exit {proc.returncode}): "
                f"{tail[-500:]}"
            )


# ─── Public API ─────────────────────────────────────────────────────────────


def index_frames(
    source_path: Path,
    out_path: Path,
    *,
    progress: ProgressFn | None = None,
    batch_size: int = 32,
) -> int:
    """Index every Nth frame of ``source_path`` and persist embeddings to
    ``out_path`` as a single ``.npz`` containing ``timestamps`` (M,) and
    ``embeddings`` (M, dim). Returns the number of frames indexed.
    """
    import torch

    if progress:
        progress(0.0, "Probing source duration…")
    duration = _probe_duration(source_path)
    expected_frames = max(1, int(duration * _FRAMES_PER_SECOND))

    model, preprocess, _tokenizer = _load_clip(progress=progress)

    if progress:
        progress(0.15, f"Encoding ~{expected_frames} frames…")

    timestamps: list[float] = []
    embeddings: list[np.ndarray] = []
    batch_imgs: list = []
    batch_ts: list[float] = []

    def _flush() -> None:
        if not batch_imgs:
            return
        with torch.no_grad():
            tensor = torch.stack(batch_imgs)
            feats = model.encode_image(tensor)
            # L2-normalize once at index time so query-time math is a
            # plain dot product.
            feats = feats / feats.norm(dim=-1, keepdim=True)
        embeddings.append(feats.cpu().numpy().astype("float32"))
        timestamps.extend(batch_ts)
        batch_imgs.clear()
        batch_ts.clear()

    for i, (ts, img) in enumerate(_extract_frames(source_path)):
        batch_imgs.append(preprocess(img))
        batch_ts.append(ts)
        if len(batch_imgs) >= batch_size:
            _flush()
        if progress and expected_frames > 0 and i % 10 == 0:
            # 0.15-0.95 covers the encode pass; finishing happens in the
            # 0.95-1.0 slice (save + close).
            frac = 0.15 + 0.80 * min(i / expected_frames, 0.99)
            progress(frac, f"Encoding frame {i + 1}/~{expected_frames}…")
    _flush()

    if not embeddings:
        raise RuntimeError(
            "Frame extraction produced no images — is the source a valid video?"
        )

    if progress:
        progress(0.97, "Saving index…")
    all_emb = np.concatenate(embeddings, axis=0)
    np.savez(
        out_path,
        timestamps=np.asarray(timestamps, dtype="float32"),
        embeddings=all_emb,
        model=_CLIP_MODEL,
        pretrained=_CLIP_PRETRAINED,
        source_duration=np.float32(duration),
    )
    if progress:
        progress(1.0, f"Indexed {len(timestamps)} frames.")
    return len(timestamps)


def search(
    index_path: Path,
    query: str,
    *,
    top_k: int = 5,
    min_score: float = 0.20,
    merge_window_seconds: float = 4.0,
) -> list[dict]:
    """Return the top-K timestamps in ``index_path`` matching ``query``.

    Scores are CLIP cosine similarities in [0, 1]-ish (technically -1..1
    but for typical photo/text pairs they sit in 0.15-0.40 for "good"
    matches). We filter at ``min_score`` to avoid surfacing garbage when
    the query doesn't match anything in the video.

    Adjacent matches within ``merge_window_seconds`` are merged into a
    single result with the peak score — the user usually wants "where
    in the video" not "every single frame where."
    """
    import torch

    data = np.load(str(index_path), allow_pickle=False)
    timestamps: np.ndarray = data["timestamps"]
    embeddings: np.ndarray = data["embeddings"]

    model, _preprocess, tokenizer = _load_clip()
    with torch.no_grad():
        tokens = tokenizer([query])
        text_feat = model.encode_text(tokens)
        text_feat = text_feat / text_feat.norm(dim=-1, keepdim=True)
    text_vec = text_feat.cpu().numpy().astype("float32")[0]
    scores = embeddings @ text_vec  # (N,)
    # Sort high-to-low, then walk forward merging consecutive matches.
    order = np.argsort(-scores)

    merged: list[dict] = []
    used = np.zeros(len(timestamps), dtype=bool)
    for idx in order:
        if used[idx]:
            continue
        s = float(scores[idx])
        if s < min_score:
            break
        t = float(timestamps[idx])
        # Suppress neighbors within the merge window — they're the same
        # moment from the model's POV.
        lo = max(0, idx - int(merge_window_seconds * _FRAMES_PER_SECOND))
        hi = min(len(timestamps), idx + int(merge_window_seconds * _FRAMES_PER_SECOND) + 1)
        used[lo:hi] = True
        merged.append(
            {
                "time": round(t, 2),
                "score": round(s, 3),
            }
        )
        if len(merged) >= top_k:
            break
    return merged


# ─── Helpers ────────────────────────────────────────────────────────────────


def _probe_duration(source_path: Path) -> float:
    """Get video duration in seconds via ffprobe. Cheap; runs once per
    index build to size the progress bar."""
    try:
        out = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(source_path),
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        return float(out)
    except (subprocess.CalledProcessError, ValueError):
        return 0.0


# Re-exported for callers that just want to know the index is loadable.
def index_summary(index_path: Path) -> dict:
    data = np.load(str(index_path), allow_pickle=False)
    return {
        "frame_count": int(data["timestamps"].shape[0]),
        "source_duration": float(data["source_duration"]),
        "model": str(data["model"]),
        "pretrained": str(data["pretrained"]),
    }
