// Thin typed wrapper around the FastAPI sidecar.
// Uses /api as the base — Vite's dev server proxies it to the Python server.

import type {
  JobEvent,
  JobHandle,
  JobStatusResponse,
  ProbeResponse,
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

  // ─── Media URLs (no fetch needed; use directly as src) ─────────────────
  fileUrl: (name: string) => `${BASE}/files/${encodeURIComponent(name)}`,

  audioClipUrl: (audio_path: string, start: number, end: number, pad = 1.5) =>
    `${BASE}/audio-clip?audio_path=${encodeURIComponent(audio_path)}` +
    `&start=${start}&end=${end}&pad=${pad}`,
};

export { APIError };
