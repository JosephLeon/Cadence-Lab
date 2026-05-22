/**
 * A tiny outside-React holder for the currently-active <video> element ref.
 *
 * Why not Zustand: imperative video control (`video.currentTime = 12.5`,
 * `video.play()`) is fundamentally outside the render cycle. Putting the ref
 * in Zustand would either trigger re-renders on every change or require
 * non-reactive access — at which point it's just a module-level singleton.
 */

let current: HTMLVideoElement | null = null;

export const videoRef = {
  set(el: HTMLVideoElement | null) {
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
};
