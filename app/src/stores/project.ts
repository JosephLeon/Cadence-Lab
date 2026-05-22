import { create } from "zustand";
import type { SourceProbe } from "../api/types";

/**
 * Project state — the in-memory model of what the user is currently editing.
 * Persistence (saving project state to disk, recent projects, etc.) is a
 * later concern.
 */

export interface MediaItem {
  /** Absolute path on the user's filesystem */
  path: string;
  /** Probe info; null while loading or if probe failed */
  probe: SourceProbe | null;
  /** Loading / error state for the initial probe */
  status: "loading" | "ready" | "error";
  error?: string;
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
        media: [...s.media, { path, probe: null, status: "loading" }],
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
