// Thin typed wrapper around the FastAPI sidecar.
// Uses /api as the base — Vite's dev server proxies it to the Python server.

import type {
  AudioPeaks,
  JobEvent,
  JobHandle,
  JobStatusResponse,
  PlanResponse,
  ProbeResponse,
  ThumbnailSprite,
} from "./types";

const BASE = "/api";

class APIError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`API ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

async function jsonFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new APIError(res.status, body);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // ─── Sync ──────────────────────────────────────────────────────────────
  health: () => jsonFetch<{ status: string; service: string }>("/health"),

  probe: (source_path: string) =>
    jsonFetch<ProbeResponse>("/probe", {
      method: "POST",
      body: JSON.stringify({ source_path }),
    }),

  // ─── Async: kick off + poll ────────────────────────────────────────────
  analyze: (req: {
    source_path: string;
    mic_track?: number;
    backend?: "groq" | "local";
    language?: string | null;
  }) =>
    jsonFetch<JobHandle>("/analyze", {
      method: "POST",
      body: JSON.stringify(req),
    }),

  classify: (req: { analysis_path: string; min_pause_ms?: number }) =>
    jsonFetch<JobHandle>("/classify", {
      method: "POST",
      body: JSON.stringify(req),
    }),

  plan: (req: {
    analysis_path: string;
    classified_path?: string;
    overrides?: Record<string, string>;  // "pause:5" → "keep" etc.
    crossfade_ms?: number;
    filler_pad_ms?: number;
    default_breath_ms?: number;
    min_keep_ms?: number;
  }) =>
    jsonFetch<PlanResponse>("/plan", {
      method: "POST",
      body: JSON.stringify(req),
    }),

  render: (req: {
    analysis_path: string;
    plan_path?: string;
    audio_track?: number;
    encoder?: "auto" | "h264_videotoolbox" | "libx264";
    audio_bitrate?: string;
  }) =>
    jsonFetch<JobHandle>("/render", {
      method: "POST",
      body: JSON.stringify(req),
    }),

  getJob: (id: string) => jsonFetch<JobStatusResponse>(`/jobs/${id}`),

  // ─── SSE: stream of progress events for a running job ──────────────────
  // Returns an unsubscribe function. Caller handles message + terminal.
  subscribeJob: (
    id: string,
    onEvent: (ev: JobEvent) => void,
    onError?: (err: Event) => void,
  ): (() => void) => {
    const es = new EventSource(`${BASE}/jobs/${id}/events`);
    es.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch {
        /* swallow malformed events */
      }
    };
    es.onerror = (e) => {
      if (onError) onError(e);
      es.close();
    };
    return () => es.close();
  },

  /**
   * Upload a video file via multipart. Uses XHR so the browser exposes
   * upload progress events (fetch's stream API for upload progress is
   * still patchy). Resolves with the saved path on the server.
   */
  upload: (
    file: File,
    onProgress?: (frac: number) => void,
  ): Promise<{ path: string; size_bytes: number }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append("file", file);
      xhr.upload.addEventListener("progress", (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`Upload failed (${xhr.status}): ${xhr.responseText}`));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("Upload failed")));
      xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));
      xhr.open("POST", `${BASE}/upload`);
      xhr.send(form);
    }),

  // ─── Media URLs (no fetch needed; use directly as src) ─────────────────
  fileUrl: (name: string) => `${BASE}/files/${encodeURIComponent(name)}`,

  /** URL for the user-loaded source video (used by <video src=...>) */
  sourceUrl: (path: string) =>
    `${BASE}/source?path=${encodeURIComponent(path)}`,

  audioClipUrl: (audio_path: string, start: number, end: number, pad = 1.5) =>
    `${BASE}/audio-clip?audio_path=${encodeURIComponent(audio_path)}` +
    `&start=${start}&end=${end}&pad=${pad}`,

  // ─── Visualization data (timeline) ─────────────────────────────────────
  getAudioPeaks: (audio_path: string, bins = 2000) =>
    jsonFetch<AudioPeaks>(
      `/audio-peaks?audio_path=${encodeURIComponent(audio_path)}&bins=${bins}`,
    ),

  getThumbnails: (source_path: string, count = 60, height = 60) =>
    jsonFetch<ThumbnailSprite>(
      `/thumbnails?source_path=${encodeURIComponent(source_path)}` +
        `&count=${count}&height=${height}`,
    ),

  // ─── Bundle loads ──────────────────────────────────────────────────────
  getClassification: (path: string) =>
    jsonFetch<{
      pause_candidates: { id: number; start: number; end: number }[];
      filler_candidates: {
        id: number;
        word_index: number;
        text: string;
        start: number;
        end: number;
      }[];
      classification: {
        pauses: {
          id: number;
          category: string;
          action: "cut" | "trim" | "keep";
          trim_to_ms: number | null;
          reason: string;
        }[];
        fillers: {
          id: number;
          action: "cut" | "keep";
          reason: string;
        }[];
        retakes: {
          cut_start: number;
          cut_end: number;
          keep_start: number;
          keep_end: number;
          reason: string;
        }[];
      };
    }>(`/classification?path=${encodeURIComponent(path)}`),

  getPlan: (path: string) =>
    jsonFetch<{
      source_duration: number;
      output_duration: number;
      keeps: { source_start: number; source_end: number }[];
      cuts: { source_start: number; source_end: number; kind: string; reason: string }[];
      params: { crossfade_ms: number; filler_pad_ms: number; default_breath_ms: number; min_keep_ms: number };
    }>(`/plan-bundle?path=${encodeURIComponent(path)}`),
};

export { APIError };
