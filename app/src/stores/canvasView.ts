import { create } from "zustand";

/**
 * Canvas view state — which video the center pane is showing.
 *
 * Lifted out of `Canvas` so other panels (e.g. the custom-cut preview in
 * the right panel) can switch the canvas back to the source video before
 * triggering playback. Without this, asking the canvas to "preview the
 * gap at 25.5s" while it's on the rendered/edited file would seek to the
 * wrong place — rendered files have a different time mapping than the
 * source.
 */

export type CanvasView = "source" | "edited";

interface CanvasViewState {
  view: CanvasView;
  setView: (view: CanvasView) => void;
}

export const useCanvasView = create<CanvasViewState>((set) => ({
  view: "source",
  setView: (view) => set({ view }),
}));
