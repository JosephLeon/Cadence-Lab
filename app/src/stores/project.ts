import { create } from "zustand";
import type { CanonicalPaths, SourceProbe } from "../api/types";

/**
 * Project state — the in-memory model of what the user is currently editing.
 * Persistence (saving project state to disk, recent projects, etc.) is a
 * later concern.
 */

/** Per-media pipeline state. Tracks which stages have a known output path. */
export interface PipelineState {
  analysisPath?: string;
  classifiedPath?: string;
  planPath?: string;
  renderedPath?: string;
}

/** Per-media job state. Only one stage at a time runs against a single clip. */
export interface JobState {
  stage: "analyze" | "classify" | "plan" | "render";
  jobId?: string;       // undefined for sync stages (plan)
  progress: number;
  message: string;
  error?: string;
}

export interface MediaItem {
  /** Absolute path on the user's filesystem */
  path: string;
  /** Probe info; null while loading or if probe failed */
  probe: SourceProbe | null;
  /** Canonical output paths for this source */
  canonical?: CanonicalPaths;
  /** Loading / error state for the initial probe */
  status: "loading" | "ready" | "error";
  error?: string;
  /** Pipeline artifact paths — populated by stage completions */
  pipeline: PipelineState;
  /** Active job, if any */
  job: JobState | null;
}

interface ProjectState {
  media: MediaItem[];
  activeMediaPath: string | null;

  addMedia: (path: string) => void;
  updateMedia: (path: string, patch: Partial<MediaItem>) => void;
  removeMedia: (path: string) => void;
  setActive: (path: string | null) => void;
}

export const useProject = create<ProjectState>((set) => ({
  media: [],
  activeMediaPath: null,

  addMedia: (path) =>
    set((s) => {
      if (s.media.some((m) => m.path === path)) return s;
      return {
        media: [
          ...s.media,
          {
            path,
            probe: null,
            status: "loading",
            pipeline: {},
            job: null,
          },
        ],
        activeMediaPath: s.activeMediaPath ?? path,
      };
    }),

  updateMedia: (path, patch) =>
    set((s) => ({
      media: s.media.map((m) => (m.path === path ? { ...m, ...patch } : m)),
    })),

  removeMedia: (path) =>
    set((s) => ({
      media: s.media.filter((m) => m.path !== path),
      activeMediaPath:
        s.activeMediaPath === path ? null : s.activeMediaPath,
    })),

  setActive: (path) => set({ activeMediaPath: path }),
}));
