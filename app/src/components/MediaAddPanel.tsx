import { useRef, useState } from "react";
import { api } from "../api/client";
import { useActiveProject } from "../stores/activeProject";

const VIDEO_EXTS = ["mov", "mp4", "mkv", "m4v", "avi", "webm"];
const isVideoFile = (name: string) =>
  VIDEO_EXTS.includes(name.split(".").pop()?.toLowerCase() ?? "");

/**
 * "Add media" controls — file picker, path input, and the copy/reference
 * choice that determines whether the source is duplicated into the
 * project's ``sources/`` dir or referenced in place.
 *
 * All additions go through the active project's ``POST /projects/{slug}/
 * sources`` endpoint. The project store is updated with the returned
 * manifest, and the source-sync effect in App.tsx surfaces the new source
 * into the AI and Splicing tabs.
 */
export function MediaAddPanel() {
  const project = useActiveProject((s) => s.project);
  const [pathInput, setPathInput] = useState("");
  // Multiple files queued at once (e.g. multi-select in the file picker)
  // share a single modal; the user picks copy/reference once and the same
  // choice applies to all queued items. New uploads while the modal is
  // already open get appended to the same queue.
  const [pendingAdd, setPendingAdd] = useState<
    | { paths: string[]; suggestedMode: "copy" | "reference" }
    | null
  >(null);
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const projectAvailable = !!project;

  /** Append a path to the pending-add queue, opening the modal if needed. */
  const queueAdd = (path: string, suggestedMode: "copy" | "reference") => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setError(null);
    setPendingAdd((prev) => {
      if (prev) {
        if (prev.paths.includes(trimmed)) return prev;
        return { ...prev, paths: [...prev.paths, trimmed] };
      }
      return { paths: [trimmed], suggestedMode };
    });
  };

  const performAdd = async (mode: "copy" | "reference") => {
    if (!project || !pendingAdd) return;
    try {
      // Add sources sequentially: the manifest is small but each call
      // does a fs copy + JSON write, and we want a clean "latest manifest
      // wins" order rather than racing PUT/POSTs.
      let latest = project;
      for (const p of pendingAdd.paths) {
        latest = await api.addSource(project.slug, p, mode);
      }
      useActiveProject.setState({
        project: { ...latest, path: project.path },
      });
      setPendingAdd(null);
      setPathInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const uploadAndQueue = async (file: File) => {
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
      // Browser-uploaded files live in a temp dir; copying into the project
      // makes more sense than referencing a temp location.
      queueAdd(res.path, "copy");
    } catch (err) {
      setUploads((u) => {
        const next = { ...u };
        delete next[file.name];
        return next;
      });
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(uploadAndQueue);
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
        disabled={!projectAvailable}
        className="w-full h-9 rounded-md border border-dashed border-border hover:border-accent hover:bg-accent/5 text-sm text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span className="text-base">＋</span>
        <span>Choose video file…</span>
      </button>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Files-already-on-disk default to reference; user can pick
          // copy in the confirm modal. Keeps users editing big externals
          // from blowing up project dirs by mistake.
          queueAdd(pathInput, "reference");
        }}
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="…or paste a path"
            disabled={!projectAvailable}
            className="flex-1 min-w-0 h-8 rounded-md border border-border bg-bg px-2 text-sm placeholder:text-text-muted focus:outline-none focus:border-accent disabled:opacity-40"
          />
          <button
            type="submit"
            disabled={!projectAvailable || !pathInput.trim()}
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

      {error && (
        <div className="text-[10px] text-rose-400 px-1" title={error}>
          ✗ {error}
        </div>
      )}

      {pendingAdd && (
        <AddSourceModal
          paths={pendingAdd.paths}
          suggestedMode={pendingAdd.suggestedMode}
          onCancel={() => setPendingAdd(null)}
          onConfirm={performAdd}
        />
      )}
    </div>
  );
}

function AddSourceModal({
  paths,
  suggestedMode,
  onCancel,
  onConfirm,
}: {
  paths: string[];
  suggestedMode: "copy" | "reference";
  onCancel: () => void;
  onConfirm: (mode: "copy" | "reference") => void;
}) {
  const [mode, setMode] = useState<"copy" | "reference">(suggestedMode);
  const count = paths.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="w-[480px] rounded-lg border border-border bg-bg-panel shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-text-primary mb-1">
          Add {count === 1 ? "source" : `${count} sources`} to project
        </h3>
        <ul
          className="text-xs text-text-muted mb-4 max-h-24 overflow-y-auto space-y-0.5"
          title={paths.join("\n")}
        >
          {paths.map((p) => (
            <li key={p} className="truncate">
              {p.split("/").pop() ?? p}
            </li>
          ))}
        </ul>

        <fieldset className="space-y-2">
          <ModeOption
            value="copy"
            current={mode}
            onPick={setMode}
            label="Copy into project"
            sub="Recommended for portability. The project directory becomes self-contained — survives the original being moved, renamed, or deleted."
          />
          <ModeOption
            value="reference"
            current={mode}
            onPick={setMode}
            label="Reference in place"
            sub="No disk used. The project breaks if the file is later moved or renamed. Good for large files you're still editing elsewhere."
          />
        </fieldset>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-3 rounded bg-bg-elevated hover:bg-border text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(mode)}
            className="h-8 px-4 rounded bg-accent hover:bg-accent/80 text-white text-sm font-medium"
          >
            Add source
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeOption({
  value,
  current,
  onPick,
  label,
  sub,
}: {
  value: "copy" | "reference";
  current: "copy" | "reference";
  onPick: (v: "copy" | "reference") => void;
  label: string;
  sub: string;
}) {
  const selected = current === value;
  return (
    <label
      className={
        "block rounded-md border p-3 cursor-pointer transition-colors " +
        (selected
          ? "border-accent bg-accent/10"
          : "border-border hover:bg-bg-elevated")
      }
    >
      <div className="flex items-start gap-2">
        <input
          type="radio"
          name="add-source-mode"
          checked={selected}
          onChange={() => onPick(value)}
          className="mt-1 accent-accent"
        />
        <div>
          <div className="text-sm font-medium text-text-primary">{label}</div>
          <div className="text-[10px] text-text-muted mt-0.5 leading-snug">
            {sub}
          </div>
        </div>
      </div>
    </label>
  );
}
