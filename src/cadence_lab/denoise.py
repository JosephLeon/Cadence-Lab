"""Neural speech denoising via DeepFilterNet.

Used as an optional alternative to the classical ``afftdn`` filter chain.
Trade-off:

- **Classical (afftdn)**: spectral-subtraction-style noise reduction.
  Fast (real-time on any CPU), zero model dependency, decent for low
  hum / static room noise. Can sound "tinny" or thin the voice on
  louder noise.
- **Neural (DeepFilterNet)**: GRU-based deep learning model trained on
  ~100k hours of speech-noise pairs. Significantly better on real-world
  noise (HVAC, keyboard clicks, fan, room reverb), preserves voice
  timbre. ~real-time-ish on CPU; first run downloads a ~6MB model into
  ``~/.cache/deepfilternet/``.

This module operates on WAV files: input WAV → cleaned WAV. The renderer
substitutes the cleaned WAV as the audio input for the encode pass when
``audio.enhance_engine == "neural"``.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable

ProgressFn = Callable[[float, str], None]


# DeepFilterNet's training sample rate. The model expects 48 kHz mono;
# we resample to/from this internally so callers can pass arbitrary
# WAVs and get back the same sample rate as input.
_DFN_SR = 48000

# Cached singleton — DFN's init_df() loads the model + state and is the
# slowest part (model download + jit compile on first run).
_MODEL_LOCK = threading.Lock()
_MODEL_STATE: tuple | None = None


def _load_dfn(progress: ProgressFn | None = None):
    """Load DeepFilterNet's model + state. Cached for the process lifetime."""
    global _MODEL_STATE
    if _MODEL_STATE is not None:
        return _MODEL_STATE
    with _MODEL_LOCK:
        if _MODEL_STATE is not None:
            return _MODEL_STATE
        if progress:
            progress(
                0.05,
                "Loading DeepFilterNet (first run downloads ~6MB model)…",
            )
        # Import lazily so a missing optional dep doesn't break the
        # whole denoise module.
        from df.enhance import init_df  # type: ignore

        # `init_df()` returns (model, df_state, model_dir_path).
        model, df_state, _ = init_df()
        _MODEL_STATE = (model, df_state)
    return _MODEL_STATE


def denoise_file(
    input_wav: Path,
    output_wav: Path,
    *,
    attenuation_lim_db: float | None = None,
    progress: ProgressFn | None = None,
) -> Path:
    """Denoise ``input_wav`` → ``output_wav``.

    ``attenuation_lim_db`` caps how much DFN can attenuate the noise
    floor — lower values are gentler (better timbre, less aggressive
    cleanup); higher values are aggressive (cleaner sound, occasional
    over-denoising artifacts on speech-adjacent noise). We map our
    ``low / medium / high`` strength settings to 12 / 24 / 40 dB.

    Returns ``output_wav`` for ergonomic chaining.
    """
    import numpy as np
    import soundfile as sf
    import torch
    from df.enhance import enhance  # type: ignore

    if progress:
        progress(0.0, "Loading audio…")
    audio, sr = sf.read(str(input_wav), dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    # Resample to DFN's expected rate.
    if sr != _DFN_SR:
        if progress:
            progress(0.10, f"Resampling {sr}Hz → {_DFN_SR}Hz…")
        from scipy.signal import resample_poly
        from math import gcd

        g = gcd(int(sr), _DFN_SR)
        audio = resample_poly(audio, _DFN_SR // g, int(sr) // g).astype("float32")

    model, df_state = _load_dfn(progress=progress)

    if progress:
        progress(0.30, "Denoising…")

    audio_t = torch.from_numpy(audio).unsqueeze(0)  # (1, samples)
    enhanced_t = enhance(
        model,
        df_state,
        audio_t,
        atten_lim_db=attenuation_lim_db,
    )
    enhanced = enhanced_t.squeeze(0).numpy()

    if progress:
        progress(0.92, "Writing cleaned audio…")
    output_wav.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output_wav), enhanced, _DFN_SR, subtype="PCM_16")
    if progress:
        progress(1.0, "Done.")
    return output_wav


def strength_to_atten_db(strength: str) -> float:
    """Map our ``low / medium / high`` UI levels onto DFN's
    attenuation-limit knob. ``off`` shouldn't be calling this — guard
    upstream — but returns 0 (passthrough) if it does."""
    return {
        "off": 0.0,
        "low": 12.0,
        "medium": 24.0,
        "high": 40.0,
    }.get(strength, 24.0)
