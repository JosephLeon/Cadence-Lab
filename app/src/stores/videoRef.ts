/**
 * A tiny outside-React holder for the currently-active <video> element ref.
 *
 * Why not Zustand: imperative video control (`video.currentTime = 12.5`,
 * `video.play()`) is fundamentally outside the render cycle. Putting the ref
 * in Zustand would either trigger re-renders on every change or require
 * non-reactive access — at which point it's just a module-level singleton.
 */

let current: HTMLVideoElement | null = null;
// Per-element handle for the in-flight preview's auto-pause listener so
// repeated previews don't stack listeners that pause each other.
let activePreviewCleanup: (() => void) | null = null;

export const videoRef = {
  set(el: HTMLVideoElement | null) {
    // Switching elements voids any in-flight preview tied to the old one.
    if (activePreviewCleanup) {
      activePreviewCleanup();
      activePreviewCleanup = null;
    }
    current = el;
  },
  get(): HTMLVideoElement | null {
    return current;
  },
  seek(t: number) {
    if (current && Number.isFinite(t)) current.currentTime = Math.max(0, t);
  },
  togglePlay() {
    if (!current) return;
    if (current.paused) void current.play();
    else current.pause();
  },

  /**
   * Audition a time range: seek to ``start - padBefore``, start playing,
   * and auto-pause when playback passes ``end + padAfter``. Used by the
   * custom-cut preview to let the user hear/see the content that would
   * be cut.
   *
   * The cleanup is tracked so back-to-back previews don't leave stale
   * pause-listeners hanging around (each preview would fire its own
   * auto-pause and clobber a later one's playback).
   *
   * If the element is mid-load (e.g. just had its src swapped), we wait
   * for ``loadedmetadata`` before seeking — otherwise the seek silently
   * no-ops and the user sees a blank canvas.
   */
  previewRange(
    start: number,
    end: number,
    opts: { padBefore?: number; padAfter?: number } = {},
  ) {
    const el = current;
    if (!el || !Number.isFinite(start) || !Number.isFinite(end)) return;
    const padBefore = opts.padBefore ?? 1.0;
    const padAfter = opts.padAfter ?? 1.0;
    const from = Math.max(0, start - padBefore);
    const to = end + padAfter;

    if (activePreviewCleanup) {
      activePreviewCleanup();
      activePreviewCleanup = null;
    }

    const onTime = () => {
      if (!current) return;
      if (current.currentTime >= to) {
        current.pause();
        if (activePreviewCleanup) {
          activePreviewCleanup();
          activePreviewCleanup = null;
        }
      }
    };
    el.addEventListener("timeupdate", onTime);
    activePreviewCleanup = () => {
      el.removeEventListener("timeupdate", onTime);
    };

    const startPlayback = () => {
      el.currentTime = from;
      void el.play().catch(() => {
        /* user-initiated; ignore autoplay rejection on edge cases */
      });
    };
    if (el.readyState >= 1) {
      startPlayback();
    } else {
      const onLoaded = () => {
        el.removeEventListener("loadedmetadata", onLoaded);
        startPlayback();
      };
      el.addEventListener("loadedmetadata", onLoaded);
    }
  },
};
