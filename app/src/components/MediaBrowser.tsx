import { useState } from "react";
import { useProject } from "../stores/project";
import { MediaAddPanel, type MediaManager } from "./MediaAddPanel";

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function MediaBrowser() {
  const media = useProject((s) => s.media);
  const active = useProject((s) => s.activeMediaPath);
  const addMedia = useProject((s) => s.addMedia);
  const updateMedia = useProject((s) => s.updateMedia);
  const removeMedia = useProject((s) => s.removeMedia);
  const setActive = useProject((s) => s.setActive);

  const [dragOver, setDragOver] = useState(false);

  const manager: MediaManager = {
    add: (path) => addMedia(path),
    setProbed: (path, probe, p) => {
      // Derive the mic WAV path: same directory and stem as the source,
      // with a fixed suffix — matches what paths.mic_wav_path() writes.
      const stem = path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
      const dir = p.analysis.substring(0, p.analysis.lastIndexOf("/"));
      const micWavPath = `${dir}/${stem}.mic.16k.wav`;
      updateMedia(path, {
        probe,
        canonical: p,
        status: "ready",
        pipeline: {
          analysisPath: p.analysis_exists ? p.analysis : undefined,
          classifiedPath: p.classified_exists ? p.classified : undefined,
          planPath: p.plan_exists ? p.plan : undefined,
          renderedPath: p.rendered_exists ? p.rendered : undefined,
          micWavPath: p.analysis_exists ? micWavPath : undefined,
        },
      });
    },
    setError: (path, error) => updateMedia(path, { status: "error", error }),
  };

  return (
    <aside
      className="w-72 shrink-0 border-r border-border bg-bg-panel flex flex-col relative"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        // Files dropped on the panel are handled by MediaAddPanel via its
        // own input; here we just absorb the drop so the browser doesn't
        // navigate to the file URL.
      }}
    >
      <div className="h-10 shrink-0 border-b border-border flex items-center px-3">
        <h2 className="text-sm font-medium text-text-secondary uppercase tracking-wider">
          Media
        </h2>
      </div>

      <MediaAddPanel manager={manager} />

      {/* Media list */}
      <div className="flex-1 overflow-y-auto">
        {media.length === 0 ? (
          <div className="p-4 text-sm text-text-muted text-center">
            No media yet.
            <br />
            Drop a video here or use the buttons above.
          </div>
        ) : (
          <ul className="p-2 space-y-1">
            {media.map((m) => {
              const name = m.path.split("/").pop() ?? m.path;
              const isActive = active === m.path;
              return (
                <li
                  key={m.path}
                  onClick={() => setActive(m.path)}
                  className={
                    "group cursor-pointer rounded-md px-2 py-2 transition-colors " +
                    (isActive
                      ? "bg-accent/15 border border-accent/40"
                      : "border border-transparent hover:bg-bg-elevated")
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div
                        className="text-sm font-medium truncate"
                        title={m.path}
                      >
                        {name}
                      </div>
                      <div
                        className="text-xs text-text-muted truncate"
                        title={m.path}
                      >
                        {m.path}
                      </div>
                    </div>
                    <button
                      className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-rose-400 text-xs px-1 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeMedia(m.path);
                      }}
                      title="Remove from project"
                    >
                      ✕
                    </button>
                  </div>

                  {m.status === "loading" && (
                    <div className="mt-1 text-xs text-text-secondary">
                      Probing…
                    </div>
                  )}
                  {m.status === "error" && (
                    <div
                      className="mt-1 text-xs text-rose-400 truncate"
                      title={m.error}
                    >
                      ✗ {m.error ?? "Failed"}
                    </div>
                  )}
                  {m.status === "ready" && m.probe && (
                    <div className="mt-1 flex gap-3 text-xs text-text-secondary">
                      <span>{fmtDuration(m.probe.duration_seconds)}</span>
                      {m.probe.width && (
                        <span>
                          {m.probe.width}×{m.probe.height}
                        </span>
                      )}
                      {m.probe.audio_tracks.length > 0 && (
                        <span>{m.probe.audio_tracks.length}ch</span>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Drag overlay */}
      {dragOver && (
        <div className="absolute inset-0 bg-accent/15 border-2 border-dashed border-accent rounded-md pointer-events-none flex items-center justify-center z-20">
          <div className="text-accent font-medium">Drop to upload</div>
        </div>
      )}
    </aside>
  );
}

// Re-export for compatibility with anyone importing fmtBytes
export { fmtBytes };
