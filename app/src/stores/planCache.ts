/**
 * Module-level cache of the active plan's keep-segment boundaries.
 *
 * The keyboard shortcut hook needs "jump to next/prev cut" but lives in a
 * different render tree from the Timeline (which is what actually subscribes
 * to the plan data via TanStack Query). Rather than thread the plan through
 * a context provider, the Timeline pushes its boundaries into this cache
 * after each fetch and the keyboard hook reads them.
 *
 * Same pattern as videoRef.ts — imperative things that live outside the
 * render cycle live outside Zustand too.
 */

/**
 * Boundaries are *cut points* — the times at which the video transitions
 * between a keep and a cut. Includes both starts and ends of keep segments,
 * sorted ascending. Empty list = no plan loaded.
 */
let boundaries: number[] = [];

export const planCache = {
  set(xs: number[]) {
    // Sort + dedupe (keep boundaries can touch; deduped values look nicer
    // when jumping).
    boundaries = [...new Set(xs)].sort((a, b) => a - b);
  },

  /** First boundary strictly after `t` (with a tiny epsilon to avoid jitter). */
  next(t: number): number | undefined {
    return boundaries.find((b) => b > t + 0.05);
  },

  /** Last boundary strictly before `t`. */
  prev(t: number): number | undefined {
    let result: number | undefined;
    for (const b of boundaries) {
      if (b < t - 0.05) result = b;
      else break;
    }
    return result;
  },

  count(): number {
    return boundaries.length;
  },
};
