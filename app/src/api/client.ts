// Thin typed wrapper around the FastAPI sidecar.
// Uses /api as the base — Vite's dev server proxies it to the Python server.

import type {
  AudioPeaks,
  CadenceQueryResponse,
  CadenceTurn,
  JobEvent,
  JobHandle,
  JobStatusResponse,
  PlanResponse,
  ProbeResponse,
  Project,
  ProjectsListResponse,
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

  // ─── Projects ──────────────────────────────────────────────────────────
  listProjects: () => jsonFetch<ProjectsListResponse>("/projects"),

  createProject: (name: string) =>
    jsonFetch<Project>("/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  loadProject: (slug: string) =>
    jsonFetch<Project>(`/projects/${encodeURIComponent(slug)}`),

  /** Replace the full manifest for ``slug``. Server validates schema. */
  saveProject: (slug: string, project: Project) =>
    jsonFetch<Project>(`/projects/${encodeURIComponent(slug)}`, {
      method: "PUT",
      body: JSON.stringify(project),
    }),

  addSource: (slug: string, path: string, mode: "copy" | "reference") =>
    jsonFetch<Project>(
      `/projects/${encodeURIComponent(slug)}/sources`,
      {
        method: "POST",
        body: JSON.stringify({ path, mode }),
      },
    ),

  /** Remove a source from the project's manifest. Returns the updated
   *  manifest. ``path`` is the manifest's ``sources[i].path`` value, not
   *  the absolute filesystem path. */
  removeSource: (
    slug: string,
    path: string,
    opts: { deleteFile?: boolean } = {},
  ) => {
    const params = new URLSearchParams({ path });
    if (opts.deleteFile) params.set("delete_file", "true");
    return jsonFetch<Project>(
      `/projects/${encodeURIComponent(slug)}/sources?${params.toString()}`,
      { method: "DELETE" },
    );
  },

  /** Irreversibly delete a project (directory + manifest + all artifacts/renders). */
  deleteProject: (slug: string) =>
    jsonFetch<{ status: string; slug: string }>(
      `/projects/${encodeURIComponent(slug)}`,
      { method: "DELETE" },
    ),

  /** Single turn of the Ask Cadence conversation. The frontend builds the
   *  digest (it has live session state); the backend feeds it into Claude's
   *  system prompt along with the user message + history. */
  cadenceQuery: (req: {
    message: string;
    history: CadenceTurn[];
    project_slug: string;
    active_source_rel: string | null;
    digest_text: string;
  }) =>
    jsonFetch<CadenceQueryResponse>("/cadence/query", {
      method: "POST",
      body: JSON.stringify(req),
    }),

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

  detectEvents: (req: { source_path: string; mic_track?: number }) =>
    jsonFetch<JobHandle>("/detect-events", {
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

  spliceRender: (req: {
    clips: Array<
      | {
          kind: "video";
          source_path: string;
          source_start: number;
          source_end: number;
        }
      | { kind: "blank"; duration: number }
    >;
    output_name: string;
    target_width?: number;
    target_height?: number;
    target_fps?: number;
    encoder?: "auto" | "h264_videotoolbox" | "libx264";
    audio_bitrate?: string;
    /** When set, output is written to the project's renders/ dir and a
     *  render_history entry is appended to its manifest. */
    project_slug?: string;
  }) =>
    jsonFetch<JobHandle>("/splice/render", {
      method: "POST",
      body: JSON.stringify(req),
    }),

  render: (req: {
    /** Pacing mode: pass analysis_path (and optionally plan_path).
     *  Audio-only mode: pass source_path. Exactly one of the two. */
    analysis_path?: string;
    plan_path?: string;
    source_path?: string;
    audio_track?: number;
    encoder?: "auto" | "h264_videotoolbox" | "libx264";
    audio_bitrate?: string;
    audio?: {
      enhance_speech: "off" | "low" | "medium" | "high";
      auto_duck: boolean;
      ducking_db: number;
    };
    /** Pacing-mode re-plan inputs. When present, /render re-runs the
     *  planner with these on top of the classification before encoding,
     *  so the user's latest in-session edits always make it in. */
    overrides?: Record<string, string>;
    custom_cuts?: Array<{ start: number; end: number; reason: string }>;
    /** When set, output is written to the project's renders/ dir as
     *  `rNNN.<stem>[.paced][.<audio-suffix>].mp4` and an entry is
     *  appended to the project's render_history. */
    project_slug?: string;
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
