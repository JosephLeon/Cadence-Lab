import { useRef, useState } from "react";
import { api } from "../api/client";
import { useActiveProject } from "../stores/activeProject";
import { useProject } from "../stores/project";
import {
  describeLineage,
  detectRenderLineage,
  type RenderLineageMatch,
} from "../lib/renderLineage";

const VIDEO_EXTS = ["mov", "mp4", "mkv", "m4v", "avi", "webm"];
const isVideoFile = (name: string) =>
  VIDEO_EXTS.includes(name.split(".").pop()?.toLowerCase() ?? "");

/**
 * "Add media" controls — file picker and the copy/reference choice that
 * determines whether the source is duplicated into the project's
 * ``sources/`` dir or referenced in place.
 *
 * All additions go through the active project's ``POST /projects/{slug}/
 * sources`` endpoint. The project store is updated with the returned
 * manifest, and the source-sync effect in App.tsx surfaces the new source
 * into the AI and Splicing tabs.
 */
export function MediaAddPanel() {
  const project = useActiveProject((s) => s.project);
  // Multiple files queued at once (e.g. multi-select in the file picker)
  // share a single modal; the user picks copy/reference once and the same
  // choice applies to all queued items. New uploads while the modal is
  // already open get appended to the same queue.
  const [pendingAdd, setPendingAdd] = useState<
    | { paths: string[]; suggestedMode: "copy" | "reference" }
    | null
  >(null);
  // Lineage prompt: shown when the user tries to add a file that's
  // actually a render in this project's history. Distinct from the add
  // modal so the user can pick "continue editing source" without going
  // through the copy-vs-reference dance.
  const [lineagePrompt, setLineagePrompt] = useState<
    | { addedPath: string; match: RenderLineageMatch; suggestedMode: "copy" | "reference" }
    | null
  >(null);
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const projectAvailable = !!project;

  /** Append a path to the pending-add queue, opening the modal if needed.
   *
   *  Special case: if the path is one of this project's previous renders,
   *  we surface a "continue editing the source instead?" prompt rather
   *  than letting the user accidentally add a derived MP4 as a fresh
   *  source (which would force a full pipeline re-run and burn tokens).
   */
  const queueAdd = (path: string, suggestedMode: "copy" | "reference") => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setError(null);
    if (project) {
      const match = detectRenderLineage(project, trimmed);
      if (match) {
        setLineagePrompt({ addedPath: trimmed, match, suggestedMode });
        return;
      }
    }
    setPendingAdd((prev) => {
      if (prev) {
        if (prev.paths.includes(trimmed)) return prev;
        return { ...prev, paths: [...prev.paths, trimmed] };
      }
      return { paths: [trimmed], suggestedMode };
    });
  };

  /** "Continue editing source" button on the lineage prompt: jump the
   *  AI tab to the source video the render was derived from. Source must
   *  already be in this project's sources (which it almost always is —
   *  a render can't exist without its source having been added). */
  const continueEditingSource = () => {
    if (!lineagePrompt?.match.sourceAbsPath) return;
    useProject.getState().setActive(lineagePrompt.match.sourceAbsPath);
    setLineagePrompt(null);
  };

  /** "Add anyway" escape hatch: drop the lineage match and treat the file
   *  as a brand-new source. The user is taking the token hit knowingly. */
  const addAnywayDespiteLineage = () => {
    if (!lineagePrompt) return;
    const { addedPath, suggestedMode } = lineagePrompt;
    setLineagePrompt(null);
    setPendingAdd((prev) => {
      if (prev) {
        if (prev.paths.includes(addedPath)) return prev;
        return { ...prev, paths: [...prev.paths, addedPath] };
      }
      return { paths: [addedPath], suggestedMode };
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

      {lineagePrompt && (
        <RenderLineageModal
          addedPath={lineagePrompt.addedPath}
          match={lineagePrompt.match}
          onContinueEditingSource={continueEditingSource}
          onAddAnyway={addAnywayDespiteLineage}
          onCancel={() => setLineagePrompt(null)}
        />
      )}
    </div>
  );
}

/**
 * "Hey, this is one of your renders" prompt.
 *
 * Surfaced whenever a user tries to add a file that matches an entry in
 * the project's render_history. The default path here is to send them
 * back to the original source so their next render reuses the cached
 * analysis and classification, costing zero new tokens. The "Add anyway"
 * button is the escape hatch for users who genuinely want to treat the
 * render as a fresh source (e.g. to A/B different classifier settings
 * against the rendered output, or because they edited it externally).
 */
function RenderLineageModal({
  addedPath,
  match,
  onContinueEditingSource,
  onAddAnyway,
  onCancel,
}: {
  addedPath: string;
  match: RenderLineageMatch;
  onContinueEditingSource: () => void;
  onAddAnyway: () => void;
  onCancel: () => void;
}) {
  const fileName = addedPath.split("/").pop() ?? addedPath;
  const sourceName = match.sourceAbsPath?.split("/").pop() ?? null;
  const canContinue = Boolean(match.sourceAbsPath);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="w-[520px] max-w-[92vw] rounded-lg border border-border bg-bg-panel shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-text-primary mb-1">
          That's one of your renders
        </h3>
        <p className="text-xs text-text-muted mb-3 leading-snug">
          <code className="font-mono">{fileName}</code> was produced by this
          project: {describeLineage(match)}.
        </p>
        <p className="text-xs text-text-muted mb-4 leading-snug">
          {canContinue ? (
            <>
              Adding it as a new source would re-run the full AI pipeline
              (transcription + classification) on the rendered audio,
              charging Anthropic and Groq tokens again. If you just want to
              iterate on this render, continue editing{" "}
              <code className="font-mono">{sourceName}</code>: tweak cuts,
              overrides, or audio settings and re-render. No new AI cost.
            </>
          ) : (
            <>
              This is a splice render, so there isn't a single source to
              jump back to. Adding it as a new source will re-run the full
              pipeline and charge new tokens.
            </>
          )}
        </p>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-3 rounded bg-bg-elevated hover:bg-border text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onAddAnyway}
            className="h-8 px-3 rounded bg-bg-elevated hover:bg-border text-sm text-text-secondary"
            title="Treat this render as a new source. The full pipeline will run and charge tokens."
          >
            Add anyway
          </button>
          {canContinue && (
            <button
              type="button"
              onClick={onContinueEditingSource}
              className="h-8 px-4 rounded bg-accent hover:bg-accent/80 text-white text-sm font-medium"
              title="Switch the AI tab to the original source. Pipeline artifacts already cached."
            >
              Continue editing {sourceName}
            </button>
          )}
        </div>
      </div>
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
