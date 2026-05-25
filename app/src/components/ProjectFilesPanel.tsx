import { useMemo, useState } from "react";
import { useActiveProject } from "../stores/activeProject";
import { useProject } from "../stores/project";
import { api } from "../api/client";
import { absoluteSourcePath } from "../lib/projectPaths";
import type {
  Project,
  ProjectRenderHistoryEntry,
  ProjectSource,
} from "../api/types";

/**
 * Collapsible Project Files panel. Lives in the AI tab's right column,
 * just under Pipeline. Shows the project's sources and accumulated
 * renders so the user can browse + play their work without leaving the
 * app or hunting through Finder.
 *
 * Renders are append-only (every export creates a new file). Clicking one
 * opens it in a modal player. Source rows make that source active in the
 * AI tab so the rest of the right panel updates to match.
 */
export function ProjectFilesPanel() {
  const project = useActiveProject((s) => s.project);
  const [open, setOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(true);
  const [rendersOpen, setRendersOpen] = useState(true);
  const [playing, setPlaying] = useState<{
    label: string;
    absPath: string;
  } | null>(null);

  // Newest-first; the manifest stores chronological order.
  const renders = useMemo<ProjectRenderHistoryEntry[]>(
    () => (project ? [...project.render_history].reverse() : []),
    [project],
  );

  if (!project) return null;

  return (
    <section>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-bg-elevated transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-text-muted text-xs w-3 shrink-0">
            {open ? "▾" : "▸"}
          </span>
          <h3 className="text-[10px] font-medium tracking-widest uppercase text-text-muted shrink-0">
            Project Files
          </h3>
          {!open && (
            <span className="text-xs text-text-secondary truncate">
              {project.sources.length} sources · {renders.length} renders
            </span>
          )}
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {/* Sources */}
          <div className="rounded-md border border-border bg-bg">
            <button
              onClick={() => setSourcesOpen((o) => !o)}
              className="w-full flex items-center justify-between px-2 py-1.5 text-[10px] uppercase tracking-wider text-text-muted hover:bg-bg-elevated transition-colors"
            >
              <span className="flex items-center gap-1">
                <span className="w-3">{sourcesOpen ? "▾" : "▸"}</span>
                Sources ({project.sources.length})
              </span>
            </button>
            {sourcesOpen && (
              <ul>
                {project.sources.length === 0 ? (
                  <li className="px-3 py-2 text-[10px] text-text-muted">
                    No sources yet.
                  </li>
                ) : (
                  project.sources.map((s) => (
                    <SourceRow key={s.path} project={project} source={s} />
                  ))
                )}
              </ul>
            )}
          </div>

          {/* Renders */}
          <div className="rounded-md border border-border bg-bg">
            <button
              onClick={() => setRendersOpen((o) => !o)}
              className="w-full flex items-center justify-between px-2 py-1.5 text-[10px] uppercase tracking-wider text-text-muted hover:bg-bg-elevated transition-colors"
            >
              <span className="flex items-center gap-1">
                <span className="w-3">{rendersOpen ? "▾" : "▸"}</span>
                Renders ({renders.length})
              </span>
            </button>
            {rendersOpen && (
              <ul>
                {renders.length === 0 ? (
                  <li className="px-3 py-2 text-[10px] text-text-muted">
                    Renders will appear here as you export.
                  </li>
                ) : (
                  renders.map((r) => (
                    <RenderRow
                      key={r.id}
                      project={project}
                      render={r}
                      onPlay={() =>
                        setPlaying({
                          label: r.label,
                          absPath: `${project.path}/${r.output}`,
                        })
                      }
                    />
                  ))
                )}
              </ul>
            )}
          </div>
        </div>
      )}

      {playing && (
        <RenderPlayerModal
          label={playing.label}
          absPath={playing.absPath}
          onClose={() => setPlaying(null)}
        />
      )}
    </section>
  );
}

function SourceRow({
  project,
  source,
}: {
  project: Project;
  source: ProjectSource;
}) {
  const setActive = useProject((s) => s.setActive);
  const active = useProject((s) => s.activeMediaPath);
  const media = useProject((s) => s.media);

  const abs = absoluteSourcePath(project, source);
  const item = media.find((m) => m.path === abs);
  const isActive = active === abs;
  const fileName = source.path.split("/").pop() ?? source.path;

  return (
    <li>
      <button
        onClick={() => setActive(abs)}
        className={
          "w-full text-left px-3 py-1.5 text-xs hover:bg-bg-elevated transition-colors " +
          (isActive ? "bg-accent/10 border-l-2 border-accent" : "")
        }
        title={abs}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-text-primary truncate">
            {fileName}
          </span>
          {source.ref_mode === "external" && (
            <span className="text-[9px] text-text-muted shrink-0 font-mono">
              EXT
            </span>
          )}
        </div>
        <div className="text-[10px] text-text-muted flex gap-2 mt-0.5">
          {item?.probe ? (
            <>
              <span>{fmtDuration(item.probe.duration_seconds)}</span>
              {item.probe.width && (
                <span>
                  {item.probe.width}×{item.probe.height}
                </span>
              )}
            </>
          ) : (
            <span>{item?.status === "loading" ? "probing…" : "—"}</span>
          )}
        </div>
      </button>
    </li>
  );
}

function RenderRow({
  project,
  render,
  onPlay,
}: {
  project: Project;
  render: ProjectRenderHistoryEntry;
  onPlay: () => void;
}) {
  const fileName = render.output.split("/").pop() ?? render.output;
  return (
    <li>
      <button
        onClick={onPlay}
        className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg-elevated transition-colors"
        title={`${project.path}/${render.output}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-text-muted shrink-0">
            {render.id}
          </span>
          <span className="font-medium text-text-primary truncate flex-1">
            {render.label}
          </span>
          <span className="text-[9px] text-text-muted shrink-0">▶</span>
        </div>
        <div className="text-[10px] text-text-muted flex gap-2 mt-0.5 truncate">
          <span className="truncate">{fileName}</span>
          {render.size_bytes && (
            <span className="shrink-0">{fmtBytes(render.size_bytes)}</span>
          )}
          <span className="shrink-0">{fmtRelative(render.timestamp)}</span>
        </div>
      </button>
    </li>
  );
}

function RenderPlayerModal({
  label,
  absPath,
  onClose,
}: {
  label: string;
  absPath: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="w-[min(900px,90vw)] rounded-lg border border-border bg-bg-panel shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <div className="text-sm font-medium text-text-primary truncate">
            {label}
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-sm"
          >
            ✕
          </button>
        </div>
        <video
          src={api.sourceUrl(absPath)}
          controls
          autoPlay
          className="w-full max-h-[70vh] bg-black"
        />
        <div className="px-4 py-2 text-[10px] text-text-muted font-mono truncate">
          {absPath}
        </div>
      </div>
    </div>
  );
}

function fmtDuration(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0:00";
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

function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
