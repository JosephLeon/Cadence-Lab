import { useEffect } from "react";
import { videoRef } from "../stores/videoRef";

/**
 * Global keyboard shortcuts for video playback. Intentionally minimal:
 * - **Space**: play/pause
 * - **Left / Right**: seek ±5 s
 * - **Shift+Left / Shift+Right**: seek ±1 s (frame-ish)
 * - **J / L**: seek ±10 s (Premiere convention)
 *
 * Skipped when focus is inside an editable element so typing into the
 * command bar doesn't toggle playback.
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (e.target as HTMLElement | null)?.isContentEditable
      ) {
        return;
      }

      const v = videoRef.get();
      if (!v) return;

      switch (e.code) {
        case "Space":
          e.preventDefault();
          videoRef.togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          videoRef.seek(v.currentTime - (e.shiftKey ? 1 : 5));
          break;
        case "ArrowRight":
          e.preventDefault();
          videoRef.seek(v.currentTime + (e.shiftKey ? 1 : 5));
          break;
        case "KeyJ":
          e.preventDefault();
          videoRef.seek(v.currentTime - 10);
          break;
        case "KeyL":
          e.preventDefault();
          videoRef.seek(v.currentTime + 10);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
