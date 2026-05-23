import { useCallback, useEffect, useState } from "react";

/**
 * Persisted timeline UI state — height (vertical) and zoom (horizontal).
 *
 * - **height**: timeline pane height in pixels. Resized by dragging the top
 *   edge. Clamped to a sensible range so the user can't accidentally make
 *   it 0px or larger than the viewport.
 * - **zoom**: horizontal scale factor. 1.0 = fits the available width, 2.0
 *   = content is twice as wide (so half the duration is visible). Pan
 *   offset is owned by the scroll container itself (browser-native scrollLeft).
 *
 * Both are saved to localStorage so the user's preferred working size
 * survives reloads.
 */

const STORAGE_KEY = "cadence-lab:timeline-view";

const HEIGHT_MIN = 120;
const HEIGHT_MAX_FRAC = 0.7; // can't exceed 70% of viewport
const HEIGHT_DEFAULT = 176;

const ZOOM_MIN = 1;
const ZOOM_MAX = 50;
const ZOOM_DEFAULT = 1;

interface TimelineView {
  height: number;
  zoom: number;
}

function loadInitial(): TimelineView {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TimelineView>;
      return {
        height: clampHeight(parsed.height ?? HEIGHT_DEFAULT),
        zoom: clampZoom(parsed.zoom ?? ZOOM_DEFAULT),
      };
    }
  } catch {
    /* corrupt storage — ignore */
  }
  return { height: HEIGHT_DEFAULT, zoom: ZOOM_DEFAULT };
}

function clampHeight(h: number): number {
  const max = Math.max(HEIGHT_MIN, Math.floor(window.innerHeight * HEIGHT_MAX_FRAC));
  return Math.min(Math.max(h, HEIGHT_MIN), max);
}

function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return ZOOM_DEFAULT;
  return Math.min(Math.max(z, ZOOM_MIN), ZOOM_MAX);
}

export function useTimelineView() {
  const [view, setView] = useState<TimelineView>(loadInitial);

  // Persist on every change (debounce isn't worth it — writes are cheap and
  // infrequent for a single-user desktop app).
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(view));
    } catch {
      /* localStorage full / disabled — graceful no-op */
    }
  }, [view]);

  const setHeight = useCallback((next: number | ((prev: number) => number)) => {
    setView((v) => ({
      ...v,
      height: clampHeight(typeof next === "function" ? next(v.height) : next),
    }));
  }, []);

  const setZoom = useCallback((next: number | ((prev: number) => number)) => {
    setView((v) => ({
      ...v,
      zoom: clampZoom(typeof next === "function" ? next(v.zoom) : next),
    }));
  }, []);

  const fit = useCallback(() => {
    setView((v) => ({ ...v, zoom: ZOOM_DEFAULT }));
  }, []);

  return { ...view, setHeight, setZoom, fit };
}
