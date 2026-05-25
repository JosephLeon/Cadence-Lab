import { create } from "zustand";
import type {
  CanonicalPaths,
  ProjectSpliceClip,
  SourceProbe,
} from "../api/types";
import { useActiveProject } from "./activeProject";
import { projectRelativePath } from "../lib/projectPaths";

/**
 * Splicing state — the multi-clip assembly timeline plus its own media
 * library. Independent from `useProject` so the two tabs are agnostic of
 * each other.
 *
 * Each entry on the timeline is a `SpliceClip`. The same source video can
 * appear multiple times (e.g. the same intro clip used twice) so we key
 * entries by a synthetic `id`, not by source path.
 *
 * Output ordering is implicit in array order; absolute time for any clip
 * is the running sum of preceding clips' durations.
 */

export interface SpliceMediaItem {
  path: string;
  probe: SourceProbe | null;
  canonical?: CanonicalPaths;
  status: "loading" | "ready" | "error";
  error?: string;
}

/** A timeline entry is either a sub-range of a real video, or a span of
 *  blank black that the export pipeline fills with a black video + silent
 *  audio. */
export type SpliceClip =
  | {
      kind: "video";
      id: string;
      sourcePath: string;
      sourceStart: number;
      sourceEnd: number;
      sourceDuration: number;
    }
  | {
      kind: "blank";
      id: string;
      /** Visible length in seconds. */
      duration: number;
    };

export const clipDuration = (c: SpliceClip): number =>
  c.kind === "video" ? c.sourceEnd - c.sourceStart : c.duration;

interface SplicingState {
  library: SpliceMediaItem[];
  timeline: SpliceClip[];
  /** Seconds, in the assembled output timeline. */
  playhead: number;
  isPlaying: boolean;
  /** IDs of selected timeline clips. Empty = nothing selected. */
  selectedIds: string[];

  addMedia: (path: string) => void;
  updateMedia: (path: string, patch: Partial<SpliceMediaItem>) => void;
  removeMedia: (path: string) => void;

  addClip: (sourcePath: string, sourceDuration: number, atIndex?: number) => void;
  /** Insert a blank black span at the given timeline index. */
  addBlank: (duration: number, atIndex: number) => void;
  removeClip: (id: string) => void;
  moveClip: (id: string, toIndex: number) => void;
  /** Split the clip currently under the global playhead into two clips at
   *  the playhead position. No-op if the playhead is at a clip boundary. */
  splitAtPlayhead: () => void;
  setPlayhead: (s: number) => void;
  setPlaying: (p: boolean) => void;

  /** Persisted "most recent" duration the user picked for adding space.
   *  Defaults to 5s and survives reloads via localStorage. */
  lastSpaceSeconds: number;
  setLastSpaceSeconds: (sec: number) => void;

  /** Replace selection with the given id (additive=false) or toggle the id
   *  in the current selection (additive=true). */
  selectClip: (id: string, additive: boolean) => void;
  clearSelection: () => void;
  removeSelected: () => void;

  /** Wipe library + timeline + selection + playback. Called when the
   *  active project changes; the source-sync hook then re-hydrates the
   *  library from the new project's `sources`. */
  clearAll: () => void;

  /** Replace the current timeline + lastSpaceSeconds with values from a
   *  project manifest. Called by the source-sync hook after switching or
   *  refreshing the active project. */
  hydrateFromProject: (
    timeline: SpliceClip[],
    lastSpaceSeconds: number,
  ) => void;
}

let _idCounter = 0;
const nextId = () => `clip-${Date.now()}-${++_idCounter}`;

const LAST_SPACE_KEY = "cadence-lab:splice-last-space-seconds";
function loadLastSpace(): number {
  try {
    const raw = localStorage.getItem(LAST_SPACE_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    /* ignore */
  }
  return 5;
}

/** Convert a frontend SpliceClip into its on-disk manifest form. Absolute
 *  `sourcePath` values become project-relative when the source lives inside
 *  the project dir, so the manifest stays portable. */
function clipToManifest(
  clip: SpliceClip,
  pathResolver: (abs: string) => string,
): ProjectSpliceClip {
  if (clip.kind === "video") {
    return {
      kind: "video",
      source_path: pathResolver(clip.sourcePath),
      source_start: clip.sourceStart,
      source_end: clip.sourceEnd,
      duration: 0,
    };
  }
  return {
    kind: "blank",
    source_path: null,
    source_start: 0,
    source_end: 0,
    duration: clip.duration,
  };
}

/** Inverse of `clipToManifest`. Used by `hydrateFromProject`. */
export function manifestToClip(
  entry: ProjectSpliceClip,
  resolveKey: (key: string) => string,
  resolveSourceDuration: (absPath: string) => number,
): SpliceClip {
  if (entry.kind === "video" && entry.source_path) {
    const abs = resolveKey(entry.source_path);
    return {
      kind: "video",
      id: nextId(),
      sourcePath: abs,
      sourceStart: entry.source_start,
      sourceEnd: entry.source_end,
      sourceDuration: resolveSourceDuration(abs),
    };
  }
  return {
    kind: "blank",
    id: nextId(),
    duration: entry.duration,
  };
}

/** Push the current timeline + lastSpaceSeconds into the active project's
 *  manifest. No-op when no project is loaded. */
function persistSpliceState(
  timeline: SpliceClip[],
  lastSpaceSeconds: number,
): void {
  const project = useActiveProject.getState().project;
  if (!project) return;
  const resolver = (abs: string) => projectRelativePath(project, abs);
  useActiveProject.getState().mutate((p) => {
    p.splice_state.timeline = timeline.map((c) => clipToManifest(c, resolver));
    p.splice_state.last_space_seconds = lastSpaceSeconds;
  });
}

export const useSplicing = create<SplicingState>((set, get) => ({
  library: [],
  timeline: [],
  playhead: 0,
  isPlaying: false,
  selectedIds: [],
  lastSpaceSeconds: loadLastSpace(),

  addMedia: (path) =>
    set((s) => {
      if (s.library.some((m) => m.path === path)) return s;
      return {
        library: [...s.library, { path, probe: null, status: "loading" }],
      };
    }),

  updateMedia: (path, patch) =>
    set((s) => ({
      library: s.library.map((m) => (m.path === path ? { ...m, ...patch } : m)),
    })),

  removeMedia: (path) =>
    set((s) => {
      const isOrphan = (c: SpliceClip) =>
        c.kind === "video" && c.sourcePath === path;
      const survivingClipIds = new Set(
        s.timeline.filter((c) => !isOrphan(c)).map((c) => c.id),
      );
      return {
        library: s.library.filter((m) => m.path !== path),
        timeline: s.timeline.filter((c) => !isOrphan(c)),
        selectedIds: s.selectedIds.filter((id) => survivingClipIds.has(id)),
      };
    }),

  addClip: (sourcePath, sourceDuration, atIndex) => {
    set((s) => {
      const clip: SpliceClip = {
        kind: "video",
        id: nextId(),
        sourcePath,
        sourceStart: 0,
        sourceEnd: sourceDuration,
        sourceDuration,
      };
      if (atIndex === undefined || atIndex >= s.timeline.length) {
        return { timeline: [...s.timeline, clip] };
      }
      const next = [...s.timeline];
      next.splice(Math.max(0, atIndex), 0, clip);
      return { timeline: next };
    });
    const { timeline, lastSpaceSeconds } = get();
    persistSpliceState(timeline, lastSpaceSeconds);
  },

  addBlank: (duration, atIndex) => {
    set((s) => {
      const clip: SpliceClip = {
        kind: "blank",
        id: nextId(),
        duration: Math.max(0.1, duration),
      };
      const next = [...s.timeline];
      next.splice(Math.max(0, Math.min(atIndex, next.length)), 0, clip);
      return { timeline: next };
    });
    const { timeline, lastSpaceSeconds } = get();
    persistSpliceState(timeline, lastSpaceSeconds);
  },

  removeClip: (id) => {
    set((s) => ({
      timeline: s.timeline.filter((c) => c.id !== id),
      selectedIds: s.selectedIds.filter((x) => x !== id),
    }));
    const { timeline, lastSpaceSeconds } = get();
    persistSpliceState(timeline, lastSpaceSeconds);
  },

  moveClip: (id, toIndex) => {
    set((s) => {
      const from = s.timeline.findIndex((c) => c.id === id);
      if (from === -1) return s;
      const next = [...s.timeline];
      const [clip] = next.splice(from, 1);
      const clampedTo = Math.max(0, Math.min(toIndex, next.length));
      next.splice(clampedTo, 0, clip);
      return { timeline: next };
    });
    const { timeline, lastSpaceSeconds } = get();
    persistSpliceState(timeline, lastSpaceSeconds);
  },

  splitAtPlayhead: () => {
    set((s) => {
      const at = clipAtPlayhead(s.timeline, s.playhead);
      if (!at) return s;
      const EPSILON = 0.05;
      const dur = clipDuration(at.clip);
      if (at.offset < EPSILON || at.offset > dur - EPSILON) return s;
      let left: SpliceClip;
      let right: SpliceClip;
      if (at.clip.kind === "video") {
        const splitSource = at.clip.sourceStart + at.offset;
        left = { ...at.clip, id: nextId(), sourceEnd: splitSource };
        right = { ...at.clip, id: nextId(), sourceStart: splitSource };
      } else {
        left = { ...at.clip, id: nextId(), duration: at.offset };
        right = { ...at.clip, id: nextId(), duration: dur - at.offset };
      }
      const next = [...s.timeline];
      next.splice(at.index, 1, left, right);
      return { timeline: next };
    });
    const { timeline, lastSpaceSeconds } = get();
    persistSpliceState(timeline, lastSpaceSeconds);
  },

  setPlayhead: (s) => set({ playhead: Math.max(0, s) }),
  setPlaying: (p) => set({ isPlaying: p }),

  setLastSpaceSeconds: (sec) => {
    const v = Math.max(0.1, sec);
    // Keep the localStorage value too — works as a fallback when no
    // project is active so the user still gets their last-used default.
    try {
      localStorage.setItem(LAST_SPACE_KEY, String(v));
    } catch {
      /* ignore */
    }
    set({ lastSpaceSeconds: v });
    const { timeline } = get();
    persistSpliceState(timeline, v);
  },

  selectClip: (id, additive) =>
    set((s) => {
      if (!additive) return { selectedIds: [id] };
      return s.selectedIds.includes(id)
        ? { selectedIds: s.selectedIds.filter((x) => x !== id) }
        : { selectedIds: [...s.selectedIds, id] };
    }),

  clearSelection: () => set({ selectedIds: [] }),

  removeSelected: () => {
    set((s) => {
      if (s.selectedIds.length === 0) return s;
      const sel = new Set(s.selectedIds);
      return {
        timeline: s.timeline.filter((c) => !sel.has(c.id)),
        selectedIds: [],
      };
    });
    const { timeline, lastSpaceSeconds } = get();
    persistSpliceState(timeline, lastSpaceSeconds);
  },

  clearAll: () =>
    set({
      library: [],
      timeline: [],
      playhead: 0,
      isPlaying: false,
      selectedIds: [],
    }),

  hydrateFromProject: (timeline, lastSpaceSeconds) =>
    set({
      timeline,
      lastSpaceSeconds,
      playhead: 0,
      isPlaying: false,
      selectedIds: [],
    }),
}));

/**
 * Find which clip the playhead is currently inside, plus the offset within
 * that clip. Returns null if the timeline is empty or the playhead is past
 * the end.
 */
export function clipAtPlayhead(
  timeline: SpliceClip[],
  playhead: number,
): { clip: SpliceClip; index: number; offset: number; clipStart: number } | null {
  let acc = 0;
  for (let i = 0; i < timeline.length; i++) {
    const c = timeline[i];
    const d = clipDuration(c);
    if (playhead < acc + d) {
      return { clip: c, index: i, offset: playhead - acc, clipStart: acc };
    }
    acc += d;
  }
  return null;
}

export function totalDuration(timeline: SpliceClip[]): number {
  return timeline.reduce((sum, c) => sum + clipDuration(c), 0);
}
