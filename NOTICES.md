# Third-Party Notices

Cadence Lab is MIT-licensed (see [LICENSE](LICENSE)). It depends on a number
of third-party packages and pretrained models, each governed by its own
license. This file is a best-effort attribution of the major direct
dependencies. For complete attribution including transitive dependencies,
inspect the `LICENSE` file in each package's installed directory.

## Pretrained models (downloaded at first run)

- **Whisper large-v3**: speech transcription. © OpenAI. MIT License.
  <https://github.com/openai/whisper>
- **Silero VAD**: voice activity detection. © silero-team. MIT License.
  <https://github.com/snakers4/silero-vad>
- **CLIP ViT-B/32 (OpenAI weights)**: visual semantic search.
  © OpenAI. MIT License. <https://github.com/openai/CLIP>
- **PANNs CNN14 SED**: audio event detection. © Qiuqiang Kong et al.
  Apache License 2.0. <https://github.com/qiuqiangkong/audioset_tagging_cnn>
- **AudioSet ontology** (class labels used by PANNs): © Google LLC.
  Creative Commons Attribution 4.0 International (CC-BY 4.0).
  <https://research.google.com/audioset/>
- **DeepFilterNet**: neural speech denoising model + weights.
  © Hendrik Schröter et al. MIT License.
  <https://github.com/Rikorose/DeepFilterNet>

## Python runtime dependencies

| Package | License | Project |
|---|---|---|
| anthropic | MIT | <https://github.com/anthropics/anthropic-sdk-python> |
| groq | Apache-2.0 | <https://github.com/groq/groq-python> |
| open-clip-torch | MIT | <https://github.com/mlfoundations/open_clip> |
| panns-inference | MIT | <https://github.com/qiuqiangkong/panns_inference> |
| deepfilternet / deepfilterlib | MIT | <https://github.com/Rikorose/DeepFilterNet> |
| silero-vad | MIT | <https://github.com/snakers4/silero-vad> |
| faster-whisper | MIT | <https://github.com/SYSTRAN/faster-whisper> |
| ctranslate2 (via faster-whisper) | MIT | <https://github.com/OpenNMT/CTranslate2> |
| torch / torchaudio / torchvision | BSD-3-Clause | <https://github.com/pytorch/pytorch> |
| scipy | BSD-3-Clause | <https://github.com/scipy/scipy> |
| numpy | BSD-3-Clause | <https://github.com/numpy/numpy> |
| fastapi | MIT | <https://github.com/fastapi/fastapi> |
| uvicorn | BSD-3-Clause | <https://github.com/encode/uvicorn> |
| pydantic | MIT | <https://github.com/pydantic/pydantic> |
| typer | MIT | <https://github.com/fastapi/typer> |
| soundfile | BSD-3-Clause | <https://github.com/bastibe/python-soundfile> |
| librosa | ISC | <https://github.com/librosa/librosa> |
| numba | BSD-2-Clause | <https://github.com/numba/numba> |
| ffmpeg-python | Apache-2.0 | <https://github.com/kkroening/ffmpeg-python> |
| rich | MIT | <https://github.com/Textualize/rich> |

## External tools (invoked as subprocesses)

- **FFmpeg**: © the FFmpeg developers. Licensed LGPL 2.1+ (some configurations
  include GPL components). Cadence Lab invokes `ffmpeg` and `ffprobe` as
  external subprocesses; it does not link against FFmpeg libraries.
  <https://ffmpeg.org/legal.html>

## Frontend (Tauri desktop app)

| Package | License | Project |
|---|---|---|
| Tauri 2 (core, CLI) | Apache-2.0 OR MIT | <https://github.com/tauri-apps/tauri> |
| React | MIT | <https://github.com/facebook/react> |
| Vite | MIT | <https://github.com/vitejs/vite> |
| TypeScript | Apache-2.0 | <https://github.com/microsoft/TypeScript> |
| Zustand | MIT | <https://github.com/pmndrs/zustand> |
| TanStack Query | MIT | <https://github.com/TanStack/query> |
| Tailwind CSS | MIT | <https://github.com/tailwindlabs/tailwindcss> |
| wavesurfer.js | BSD-3-Clause | <https://github.com/katspaugh/wavesurfer.js> |

## Hosted services (called at runtime)

- **Groq Cloud**: hosted Whisper transcription. Terms:
  <https://groq.com/terms/>
- **Anthropic API**: Claude Opus 4.7 (classifier + Ask Cadence). Terms:
  <https://www.anthropic.com/legal>

Both require user-supplied API keys; Cadence Lab transmits audio (to Groq)
and transcripts + chat (to Anthropic) at the user's instruction only.
Neither service is used unless the corresponding `*_API_KEY` env var is set.
