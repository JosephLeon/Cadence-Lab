import { useEffect, useRef, useState } from "react";
import { useProject } from "../stores/project";
import { videoRef } from "../stores/videoRef";
import { api } from "../api/client";

function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

type View = "source" | "edited";

export function Canvas() {
  const media = useProject((s) => s.media);
  const active = useProject((s) => s.activeMediaPath);
  const playback = useProject((s) => s.playback);
  const setPlayback = useProject((s) => s.setPlayback);
  const item = media.find((m) => m.path === active);

  const elRef = useRef<HTMLVideoElement | null>(null);
  const [view, setView] = useState<View>("source");

  // If the user switched clips or the rendered file disappeared, snap back
  // to source so we don't try to load a stale URL.
  useEffect(() => {
    if (view === "edited" && !item?.pipeline.renderedPath) {
      setView("source");
    }
  }, [view, item?.pipeline.renderedPath]);

  // Pick the correct URL based on view mode. The rendered MP4 lives under
  // the output dir, so we serve it via /files/<relative>; source uses the
  // arbitrary-path /source endpoint.
  const videoUrl = (() => {
    if (!item) return undefined;
    if (view === "edited" && item.pipeline.renderedPath) {
      return api.sourceUrl(item.pipeline.renderedPath);
    }
    return api.sourceUrl(item.path);
  })();

  // Register the <video> element with the shared ref + wire its events.
  useEffect(() => {
    videoRef.set(elRef.current);
    return () => videoRef.set(null);
  }, [active, view]);

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
  }, [active, view, setPlayback]);

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

  const hasRender = !!item.pipeline.renderedPath;

  return (
    <div className="flex-1 flex flex-col bg-bg min-h-0">
      {/* View toggle — source vs edited (when rendered MP4 exists) */}
      <div className="shrink-0 border-b border-border bg-bg-panel px-4 py-2 flex items-center gap-3">
        <div className="inline-flex rounded-md border border-border overflow-hidden">
          <button
            onClick={() => setView("source")}
            className={
              "px-3 py-1 text-xs font-medium transition-colors " +
              (view === "source"
                ? "bg-accent text-white"
                : "bg-bg text-text-secondary hover:bg-bg-elevated")
            }
          >
            Source
          </button>
          <button
            onClick={() => setView("edited")}
            disabled={!hasRender}
            className={
              "px-3 py-1 text-xs font-medium transition-colors " +
              (view === "edited"
                ? "bg-accent text-white"
                : hasRender
                ? "bg-bg text-text-secondary hover:bg-bg-elevated"
                : "bg-bg text-text-muted cursor-not-allowed opacity-50")
            }
            title={hasRender ? "Switch to rendered preview" : "Render first to enable"}
          >
            Edited
          </button>
        </div>

        <span className="text-[10px] text-text-muted">
          {view === "source"
            ? "Showing source video"
            : "Showing rendered output (with all cuts applied)"}
        </span>
      </div>

      {/* Canvas / preview area */}
      <div className="flex-1 flex items-center justify-center p-6 min-h-0">
        <div className="relative max-w-full max-h-full aspect-video bg-black rounded-md border border-border-subtle overflow-hidden shadow-xl">
          <video
            // Force remount when switching source/edited or clip — otherwise
            // the cached <video> shows the wrong file's first frame briefly.
            key={`${item.path}::${view}`}
            ref={elRef}
            src={videoUrl}
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
            {fmtTime(playback.currentTime)} /{" "}
            {fmtTime(playback.duration || item.probe.duration_seconds)}
          </span>
          <div className="h-3 w-px bg-border" />
          <span className="truncate max-w-md" title={item.path}>
            {item.path.split("/").pop()}
          </span>
          {item.probe.width && (
            <>
              <div className="h-3 w-px bg-border" />
              <span>
                {item.probe.width}×{item.probe.height}
              </span>
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
