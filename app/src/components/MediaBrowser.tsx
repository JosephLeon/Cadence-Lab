import { useRef, useState } from "react";
import { useProject } from "../stores/project";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

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

const VIDEO_EXTS = ["mov", "mp4", "mkv", "m4v", "avi", "webm"];
const isVideoFile = (name: string) =>
  VIDEO_EXTS.includes(name.split(".").pop()?.toLowerCase() ?? "");

export function MediaBrowser() {
  const media = useProject((s) => s.media);
  const active = useProject((s) => s.activeMediaPath);
  const addMedia = useProject((s) => s.addMedia);
  const updateMedia = useProject((s) => s.updateMedia);
  const removeMedia = useProject((s) => s.removeMedia);
  const setActive = useProject((s) => s.setActive);

  const [pathInput, setPathInput] = useState("");
  const [dragOver, setDragOver] = useState(false);
  // Upload progress per filename so multiple concurrent uploads each track
  // their own bar. Cleared when the upload completes.
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const qc = useQueryClient();

  const probeMut = useMutation({
    mutationFn: (path: string) => api.probe(path),
    onSuccess: (res, path) => {
      const p = res.paths;
      // Derive the mic WAV path: same directory and stem as the source,
      // with a fixed suffix — matches what paths.mic_wav_path() writes.
      // (Could ask the server explicitly, but this naming is stable.)
      const stem = path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
      const dir = p.analysis.substring(0, p.analysis.lastIndexOf("/"));
      const micWavPath = `${dir}/${stem}.mic.16k.wav`;

      updateMedia(path, {
        probe: res.source,
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

  const uploadAndAdd = async (file: File) => {
    if (!isVideoFile(file.name)) {
      // Soft error — just ignore non-video drops. Could surface a toast later.
      return;
    }
    setUploads((u) => ({ ...u, [file.name]: 0 }));
    try {
      const res = await api.upload(file, (frac) => {
        setUploads((u) => ({ ...u, [file.name]: frac }));
      });
      setUploads((u) => {
        const next = { ...u };
        delete next[file.name];
        return next;
      });
      addByPath(res.path);
    } catch (err) {
      setUploads((u) => {
        const next = { ...u };
        delete next[file.name];
        return next;
      });
      // Surface the error to the user via the media list (treat the
      // intended-path as a failed entry).
      const fakePath = `/uploads/${file.name}`;
      addMedia(fakePath);
      updateMedia(fakePath, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(uploadAndAdd);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  return (
    <aside
      className="w-72 shrink-0 border-r border-border bg-bg-panel flex flex-col relative"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="h-10 shrink-0 border-b border-border flex items-center px-3">
        <h2 className="text-sm font-medium text-text-secondary uppercase tracking-wider">
          Media
        </h2>
      </div>

      {/* Add controls — drop zone, file picker, or path input */}
      <div className="p-3 border-b border-border space-y-2">
        {/* Hidden file input — triggered by the button below */}
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,.mov,.mp4,.mkv,.m4v,.avi,.webm"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = ""; // reset so same file can be picked again
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full h-9 rounded-md border border-dashed border-border hover:border-accent hover:bg-accent/5 text-sm text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center gap-2"
          title="…or drop files anywhere on this panel"
        >
          <span className="text-base">＋</span>
          <span>Choose video file…</span>
        </button>

        {/* Path input — for files already on disk */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            addByPath(pathInput);
          }}
        >
          <div className="flex gap-2">
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder="…or paste a path"
              className="flex-1 min-w-0 h-8 rounded-md border border-border bg-bg px-2 text-sm placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
            <button
              type="submit"
              disabled={!pathInput.trim() || probeMut.isPending}
              className="shrink-0 h-8 px-3 rounded-md bg-bg-elevated hover:bg-border text-text-secondary text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Add
            </button>
          </div>
        </form>

        {/* Active uploads */}
        {Object.entries(uploads).map(([name, frac]) => (
          <div key={name} className="px-1">
            <div className="flex items-center justify-between text-[10px] mb-1">
              <span className="truncate text-text-secondary" title={name}>
                {name}
              </span>
              <span className="text-text-muted font-mono shrink-0 ml-2">
                {Math.round(frac * 100)}%
              </span>
            </div>
            <div className="h-1 bg-bg-elevated rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-150"
                style={{ width: `${Math.max(2, frac * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

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
