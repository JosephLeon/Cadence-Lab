import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CanonicalPaths, SourceProbe } from "../api/types";

const VIDEO_EXTS = ["mov", "mp4", "mkv", "m4v", "avi", "webm"];
const isVideoFile = (name: string) =>
  VIDEO_EXTS.includes(name.split(".").pop()?.toLowerCase() ?? "");

/**
 * Generic media-library manager. The add panel doesn't know or care which
 * store backs it — the AI tab uses one wrapped around `useProject`, the
 * splicing tab uses one wrapped around `useSplicing`. This keeps the two
 * tabs' libraries fully independent while sharing the upload + probe UI.
 */
export interface MediaManager {
  add: (path: string) => void;
  setProbed: (path: string, probe: SourceProbe, paths: CanonicalPaths) => void;
  setError: (path: string, error: string) => void;
}

/**
 * "Add media" controls — file picker, path input, and in-progress upload
 * bars. The manager prop decides where added media lands.
 */
export function MediaAddPanel({ manager }: { manager: MediaManager }) {
  const [pathInput, setPathInput] = useState("");
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const qc = useQueryClient();

  const probeMut = useMutation({
    mutationFn: (path: string) => api.probe(path),
    onSuccess: (res, path) => manager.setProbed(path, res.source, res.paths),
    onError: (err: Error, path) => manager.setError(path, err.message),
  });

  const addByPath = (rawPath: string) => {
    const path = rawPath.trim();
    if (!path) return;
    manager.add(path);
    probeMut.mutate(path);
    setPathInput("");
    qc.invalidateQueries({ queryKey: ["media"] });
  };

  const uploadAndAdd = async (file: File) => {
    if (!isVideoFile(file.name)) return;
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
      const fakePath = `/uploads/${file.name}`;
      manager.add(fakePath);
      manager.setError(
        fakePath,
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(uploadAndAdd);
  };

  return (
    <div className="p-3 border-b border-border space-y-2">
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,.mov,.mp4,.mkv,.m4v,.avi,.webm"
        multiple
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        className="w-full h-9 rounded-md border border-dashed border-border hover:border-accent hover:bg-accent/5 text-sm text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center gap-2"
      >
        <span className="text-base">＋</span>
        <span>Choose video file…</span>
      </button>

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
  );
}
