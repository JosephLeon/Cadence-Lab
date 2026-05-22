import { useEffect, useRef } from "react";
import { useProject } from "../stores/project";
import { videoRef } from "../stores/videoRef";
import { api } from "../api/client";

function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function Canvas() {
  const media = useProject((s) => s.media);
  const active = useProject((s) => s.activeMediaPath);
  const playback = useProject((s) => s.playback);
  const setPlayback = useProject((s) => s.setPlayback);
  const item = media.find((m) => m.path === active);

  const elRef = useRef<HTMLVideoElement | null>(null);

  // Mount/unmount: register the <video> element with the shared ref so the
  // Timeline (and keyboard shortcuts) can drive it imperatively.
  useEffect(() => {
    videoRef.set(elRef.current);
    return () => videoRef.set(null);
  }, [active]);

  // Wire <video> events → Zustand playback state.
  useEffect(() => {
    const v = elRef.current;
    if (!v) return;
    const onTime = () => setPlayback({ currentTime: v.currentTime });
    const onLoaded = () => setPlayback({ duration: v.duration });
    const onPlay = () => setPlayback({ isPlaying: true });
    const onPause = () => setPlayback({ isPlaying: false });
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onLoaded);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onLoaded);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [active, setPlayback]);

  if (!item) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg">
        <div className="text-center text-text-muted">
          <div className="text-6xl mb-3 opacity-30">▶</div>
          <div className="text-sm">
            Select a clip from the media browser to preview
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-bg min-h-0">
      {/* Canvas / preview area */}
      <div className="flex-1 flex items-center justify-center p-6 min-h-0">
        <div className="relative max-w-full max-h-full aspect-video bg-black rounded-md border border-border-subtle overflow-hidden shadow-xl">
          <video
            // Force a remount on source change to clear cached state cleanly.
            key={item.path}
            ref={elRef}
            src={api.sourceUrl(item.path)}
            controls
            className="block w-full h-full"
            preload="metadata"
          />
        </div>
      </div>

      {/* Source metadata footer */}
      {item.probe && (
        <div className="shrink-0 border-t border-border bg-bg-panel px-4 py-2 flex items-center gap-4 text-xs text-text-secondary overflow-x-auto">
          <span className="font-mono">
            {fmtTime(playback.currentTime)} / {fmtTime(playback.duration || item.probe.duration_seconds)}
          </span>
          <div className="h-3 w-px bg-border" />
          <span className="truncate max-w-md" title={item.path}>
            {item.path.split("/").pop()}
          </span>
          {item.probe.width && (
            <>
              <div className="h-3 w-px bg-border" />
              <span>{item.probe.width}×{item.probe.height}</span>
            </>
          )}
          {item.probe.frame_rate && (
            <span>{item.probe.frame_rate.toFixed(2)} fps</span>
          )}
          {item.probe.video_codec && <span>{item.probe.video_codec}</span>}
          {item.probe.is_variable_frame_rate && (
            <span className="text-amber-400">VFR</span>
          )}
        </div>
      )}
    </div>
  );
}
