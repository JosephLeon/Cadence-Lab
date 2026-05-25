import { create } from "zustand";
import type { Project } from "../api/types";
import { api } from "../api/client";

/**
 * Active project — the workspace the user is currently editing.
 *
 * The project's manifest is the source of truth: when this store mutates,
 * we PUT the whole manifest back to the server (debounced). On app start
 * we rehydrate from the last-active slug saved in localStorage.
 *
 * NOT TO BE CONFUSED with the legacy `useProject` in stores/project.ts,
 * which is the AI tab's media collection. That store will be migrated to
 * read from this one in a later step.
 */

const LAST_ACTIVE_KEY = "cadence-lab:last-active-project-slug";
const SAVE_DEBOUNCE_MS = 400;

interface ActiveProjectState {
  /** The manifest. `null` means no project is loaded. */
  project: Project | null;
  /** True between app start and the first load attempt completing. */
  loading: boolean;
  /** Last error from a load/create/save attempt; user-facing. */
  error: string | null;
  /** True while a save is queued or in flight. */
  saving: boolean;

  /** Try to load the slug saved in localStorage. No-op if none. */
  rehydrate: () => Promise<void>;

  /** Switch to a different project, persisting the new active slug. */
  open: (slug: string) => Promise<void>;

  /** Create a fresh project and switch to it. */
  create: (name: string) => Promise<Project>;

  /** Clear the active project (returns user to the welcome screen). */
  close: () => void;

  /**
   * Mutate the manifest in place and queue a save. Mutator receives a
   * mutable draft and is expected to update it; we wrap it in a fresh
   * object so React re-renders, then schedule a debounced PUT.
   */
  mutate: (update: (p: Project) => void) => void;
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useActiveProject = create<ActiveProjectState>((set, get) => {
  const scheduleSave = () => {
    if (_saveTimer) clearTimeout(_saveTimer);
    set({ saving: true });
    _saveTimer = setTimeout(() => {
      const p = get().project;
      if (!p) {
        set({ saving: false });
        return;
      }
      api
        .saveProject(p.slug, p)
        .then((saved) => set({ project: saved, saving: false, error: null }))
        .catch((e: Error) => set({ saving: false, error: e.message }));
    }, SAVE_DEBOUNCE_MS);
  };

  return {
    project: null,
    loading: true,
    error: null,
    saving: false,

    rehydrate: async () => {
      const slug = localStorage.getItem(LAST_ACTIVE_KEY);
      if (!slug) {
        set({ loading: false });
        return;
      }
      try {
        const project = await api.loadProject(slug);
        set({ project, loading: false, error: null });
      } catch {
        // Project missing or broken — clear the pointer and fall through to
        // the welcome screen rather than blocking the app.
        localStorage.removeItem(LAST_ACTIVE_KEY);
        set({ loading: false, project: null });
      }
    },

    open: async (slug: string) => {
      set({ loading: true, error: null });
      try {
        const project = await api.loadProject(slug);
        localStorage.setItem(LAST_ACTIVE_KEY, project.slug);
        set({ project, loading: false });
      } catch (e) {
        set({
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    },

    create: async (name: string) => {
      set({ loading: true, error: null });
      try {
        const project = await api.createProject(name);
        localStorage.setItem(LAST_ACTIVE_KEY, project.slug);
        set({ project, loading: false });
        return project;
      } catch (e) {
        set({
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    },

    close: () => {
      if (_saveTimer) {
        clearTimeout(_saveTimer);
        _saveTimer = null;
      }
      localStorage.removeItem(LAST_ACTIVE_KEY);
      set({ project: null, error: null, saving: false });
    },

    mutate: (update) => {
      const current = get().project;
      if (!current) return;
      // Shallow-clone so the update function can mutate freely, then bump
      // the modified_at locally; the server overrides this on save.
      const next: Project = JSON.parse(JSON.stringify(current));
      update(next);
      next.modified_at = new Date().toISOString();
      set({ project: next });
      scheduleSave();
    },
  };
});
