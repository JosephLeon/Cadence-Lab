import { useState } from "react";
import { useProject } from "../stores/project";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function MediaBrowser() {
  const media = useProject((s) => s.media);
  const active = useProject((s) => s.activeMediaPath);
  const addMedia = useProject((s) => s.addMedia);
  const updateMedia = useProject((s) => s.updateMedia);
  const removeMedia = useProject((s) => s.removeMedia);
  const setActive = useProject((s) => s.setActive);

  const [pathInput, setPathInput] = useState("");
  const qc = useQueryClient();

  const probeMut = useMutation({
    mutationFn: (path: string) => api.probe(path),
    onSuccess: (res, path) => {
      updateMedia(path, { probe: res.source, status: "ready" });
    },
    onError: (err: Error, path) => {
      updateMedia(path, { status: "error", error: err.message });
    },
  });

  const addByPath = (rawPath: string) => {
    const path = rawPath.trim();
    if (!path) return;
    addMedia(path);
    probeMut.mutate(path);
    setPathInput("");
    qc.invalidateQueries({ queryKey: ["media"] });
  };

  return (
    <aside className="w-72 shrink-0 border-r border-border bg-bg-panel flex flex-col">
      <div className="h-10 shrink-0 border-b border-border flex items-center px-3">
        <h2 className="text-sm font-medium text-text-secondary uppercase tracking-wider">
          Media
        </h2>
      </div>

      {/* Path input — for now a text field; Tauri will swap this for a native file dialog */}
      <form
        className="p-3 border-b border-border space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          addByPath(pathInput);
        }}
      >
        <input
          type="text"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          placeholder="Paste a video path…"
          className="w-full h-8 rounded-md border border-border bg-bg px-2 text-sm placeholder:text-text-muted focus:outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={!pathInput.trim() || probeMut.isPending}
          className="w-full h-8 rounded-md bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
        >
          {probeMut.isPending ? "Probing…" : "Add to project"}
        </button>
      </form>

      {/* Media list */}
      <div className="flex-1 overflow-y-auto">
        {media.length === 0 ? (
          <div className="p-4 text-sm text-text-muted text-center">
            No media yet.
            <br />
            Paste a path above to get started.
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
                      <div className="text-xs text-text-muted truncate" title={m.path}>
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
                    <div className="mt-1 text-xs text-text-secondary">Probing…</div>
                  )}
                  {m.status === "error" && (
                    <div className="mt-1 text-xs text-rose-400" title={m.error}>
                      Probe failed
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
    </aside>
  );
}
