import { useProject } from "../stores/project";

export function Canvas() {
  const media = useProject((s) => s.media);
  const active = useProject((s) => s.activeMediaPath);
  const item = media.find((m) => m.path === active);

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
    <div className="flex-1 flex flex-col bg-bg">
      {/* Canvas / preview area */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="relative max-w-full max-h-full aspect-video bg-black rounded-md border border-border-subtle overflow-hidden shadow-xl">
          {/*
            Real <video> playback comes in a later phase — needs either:
            - a file:// URL the browser will load (works in Tauri's webview but
              blocked by browser in dev mode), or
            - serving the source through the FastAPI sidecar as bytes (heavy
              for multi-GB files).
            Until then, show the clip's title and metadata.
          */}
          <div className="absolute inset-0 flex items-center justify-center text-text-muted">
            <div className="text-center px-6">
              <div className="text-4xl mb-2 opacity-40">▶</div>
              <div className="text-xs">Preview placeholder</div>
              <div className="text-[10px] text-text-muted mt-1">
                Native video playback wires up in Phase 3
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Source metadata footer */}
      {item.probe && (
        <div className="shrink-0 border-t border-border bg-bg-panel px-4 py-2 flex items-center gap-6 text-xs text-text-secondary">
          <span className="truncate max-w-md" title={item.path}>
            {item.path.split("/").pop()}
          </span>
          <div className="h-3 w-px bg-border" />
          <span>
            {item.probe.duration_seconds.toFixed(1)}s
          </span>
          {item.probe.width && (
            <span>
              {item.probe.width}×{item.probe.height}
            </span>
          )}
          {item.probe.frame_rate && (
            <span>{item.probe.frame_rate.toFixed(2)} fps</span>
          )}
          {item.probe.video_codec && <span>{item.probe.video_codec}</span>}
          {item.probe.is_variable_frame_rate && (
            <span className="text-amber-400">VFR</span>
          )}
          <span>{item.probe.audio_tracks.length} audio track{item.probe.audio_tracks.length === 1 ? "" : "s"}</span>
        </div>
      )}
    </div>
  );
}
