import { create } from "zustand";
import type { CanonicalPaths, SourceProbe } from "../api/types";

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

export interface SpliceClip {
  id: string;
  sourcePath: string;
  /** Seconds into the source where this clip starts playing. */
  sourceStart: number;
  /** Seconds into the source where this clip stops. */
  sourceEnd: number;
  /** Full length of the underlying source video, in seconds. Used to map
   *  the source's thumbnail sprite onto a clip showing only a sub-range. */
  sourceDuration: number;
}

/** Derived: the visible length of a clip on the timeline. */
export const clipDuration = (c: SpliceClip): number =>
  c.sourceEnd - c.sourceStart;

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
  removeClip: (id: string) => void;
  moveClip: (id: string, toIndex: number) => void;
  /** Split the clip currently under the global playhead into two clips at
   *  the playhead position. No-op if the playhead is at a clip boundary. */
  splitAtPlayhead: () => void;
  setPlayhead: (s: number) => void;
  setPlaying: (p: boolean) => void;

  /** Replace selection with the given id (additive=false) or toggle the id
   *  in the current selection (additive=true). */
  selectClip: (id: string, additive: boolean) => void;
  clearSelection: () => void;
  removeSelected: () => void;
}

let _idCounter = 0;
const nextId = () => `clip-${Date.now()}-${++_idCounter}`;

export const useSplicing = create<SplicingState>((set) => ({
  library: [],
  timeline: [],
  playhead: 0,
  isPlaying: false,
  selectedIds: [],

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
      const survivingClipIds = new Set(
        s.timeline.filter((c) => c.sourcePath !== path).map((c) => c.id),
      );
      return {
        library: s.library.filter((m) => m.path !== path),
        timeline: s.timeline.filter((c) => c.sourcePath !== path),
        selectedIds: s.selectedIds.filter((id) => survivingClipIds.has(id)),
      };
    }),

  addClip: (sourcePath, sourceDuration, atIndex) =>
    set((s) => {
      const clip: SpliceClip = {
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
    }),

  removeClip: (id) =>
    set((s) => ({
      timeline: s.timeline.filter((c) => c.id !== id),
      selectedIds: s.selectedIds.filter((x) => x !== id),
    })),

  moveClip: (id, toIndex) =>
    set((s) => {
      const from = s.timeline.findIndex((c) => c.id === id);
      if (from === -1) return s;
      const next = [...s.timeline];
      const [clip] = next.splice(from, 1);
      const clampedTo = Math.max(0, Math.min(toIndex, next.length));
      next.splice(clampedTo, 0, clip);
      return { timeline: next };
    }),

  splitAtPlayhead: () =>
    set((s) => {
      const at = clipAtPlayhead(s.timeline, s.playhead);
      if (!at) return s;
      // Don't split at exact boundaries — would produce a zero-length clip.
      const EPSILON = 0.05;
      if (at.offset < EPSILON || at.offset > clipDuration(at.clip) - EPSILON) {
        return s;
      }
      const splitSource = at.clip.sourceStart + at.offset;
      const left: SpliceClip = {
        ...at.clip,
        id: nextId(),
        sourceEnd: splitSource,
      };
      const right: SpliceClip = {
        ...at.clip,
        id: nextId(),
        sourceStart: splitSource,
      };
      const next = [...s.timeline];
      next.splice(at.index, 1, left, right);
      return { timeline: next };
    }),

  setPlayhead: (s) => set({ playhead: Math.max(0, s) }),
  setPlaying: (p) => set({ isPlaying: p }),

  selectClip: (id, additive) =>
    set((s) => {
      if (!additive) return { selectedIds: [id] };
      return s.selectedIds.includes(id)
        ? { selectedIds: s.selectedIds.filter((x) => x !== id) }
        : { selectedIds: [...s.selectedIds, id] };
    }),

  clearSelection: () => set({ selectedIds: [] }),

  removeSelected: () =>
    set((s) => {
      if (s.selectedIds.length === 0) return s;
      const sel = new Set(s.selectedIds);
      return {
        timeline: s.timeline.filter((c) => !sel.has(c.id)),
        selectedIds: [],
      };
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
