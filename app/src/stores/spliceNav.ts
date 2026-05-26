import { create } from "zustand";

/**
 * Tiny signal store for "scroll the splice timeline to the most recent
 * clip." Used by the Ask Cadence "Open in Splicing →" link so that after
 * applying a highlight, the user lands on the splice tab with the new
 * clip already in view — instead of looking at the start of the timeline
 * while their new clip sits invisible 7000 pixels to the right.
 *
 * Implemented as a monotonically-increasing counter rather than a boolean
 * so repeated requests fire each time (e.g. apply two clips, click the
 * link twice → each scroll lands).
 */

interface SpliceNavState {
  /** Increments each time something requests a scroll-to-end. The splice
   *  timeline subscribes to this number and reacts on every change. */
  scrollToEndRequests: number;
  requestScrollToEnd: () => void;
}

export const useSpliceNav = create<SpliceNavState>((set) => ({
  scrollToEndRequests: 0,
  requestScrollToEnd: () =>
    set((s) => ({ scrollToEndRequests: s.scrollToEndRequests + 1 })),
}));
