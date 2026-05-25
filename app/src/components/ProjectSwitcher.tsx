import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useActiveProject } from "../stores/activeProject";
import { useProject } from "../stores/project";
import { useSplicing } from "../stores/splicing";
import { digestProject } from "../lib/projectDigest";
import { CreateProjectModal } from "./WelcomeScreen";

/**
 * Top-bar project picker. Shows the active project's name; click to open a
 * popover with "New project…" and a list of recent projects to switch to.
 * Also shows a tiny saving indicator so the user knows their work is
 * being persisted.
 */
export function ProjectSwitcher() {
  const project = useActiveProject((s) => s.project);
  const saving = useActiveProject((s) => s.saving);
  const open = useActiveProject((s) => s.open);
  const close = useActiveProject((s) => s.close);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const qc = useQueryClient();

  const projectsQuery = useQuery({
    queryKey: ["projects-list"],
    queryFn: () => api.listProjects(),
    enabled: popoverOpen,
  });

  // Refresh the list each time the popover opens — the user may have
  // created/deleted projects in another window or via the welcome screen.
  useEffect(() => {
    if (popoverOpen) {
      void qc.invalidateQueries({ queryKey: ["projects-list"] });
    }
  }, [popoverOpen, qc]);

  // Outside-click to close.
  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [popoverOpen]);

  if (!project) return null;

  const others =
    projectsQuery.data?.projects.filter((p) => p.slug !== project.slug) ?? [];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setPopoverOpen((v) => !v)}
        className="flex items-center gap-2 h-8 px-3 rounded-md border border-border bg-bg hover:bg-bg-elevated text-sm transition-colors"
        title="Switch project"
      >
        <span className="text-text-muted text-xs">Project</span>
        <span className="font-medium text-text-primary truncate max-w-[200px]">
          {project.name}
        </span>
        <span className="text-text-muted text-xs">▾</span>
        {saving && (
          <span
            className="text-[10px] text-text-muted"
            title="Auto-saving…"
          >
            ●
          </span>
        )}
      </button>

      {popoverOpen && (
        <div className="absolute left-0 top-full mt-1 w-72 rounded-md border border-border bg-bg-panel shadow-xl z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-border">
            <div className="text-[10px] uppercase tracking-wider text-text-muted">
              Active
            </div>
            <div className="text-sm font-medium text-text-primary truncate">
              {project.name}
            </div>
          </div>
          <button
            onClick={() => {
              setCreating(true);
              setPopoverOpen(false);
            }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-bg-elevated transition-colors flex items-center gap-2"
          >
            <span className="text-text-muted">＋</span> New project…
          </button>
          <button
            onClick={() => {
              setDigestOpen(true);
              setPopoverOpen(false);
            }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-bg-elevated transition-colors border-t border-border text-text-secondary"
            title="Preview the context Ask Cadence will see"
          >
            View project digest
          </button>
          <button
            onClick={() => {
              close();
              setPopoverOpen(false);
            }}
            className="w-full text-left px-3 py-2 text-sm hover:bg-bg-elevated transition-colors border-t border-border text-text-secondary"
          >
            Close project
          </button>

          {others.length > 0 && (
            <>
              <div className="border-t border-border px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-muted bg-bg/50">
                Switch to
              </div>
              <ul className="max-h-64 overflow-y-auto">
                {others.map((p) => (
                  <li key={p.slug}>
                    <button
                      onClick={() => {
                        setPopoverOpen(false);
                        open(p.slug).catch(() => {});
                      }}
                      disabled={p.broken}
                      className="w-full text-left px-3 py-2 hover:bg-bg-elevated transition-colors disabled:opacity-50"
                    >
                      <div className="text-sm font-medium text-text-primary truncate">
                        {p.name}
                        {p.broken && (
                          <span className="text-rose-400 ml-1 text-xs">
                            (broken)
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-text-muted truncate">
                        {p.source_count ?? 0} sources ·{" "}
                        {p.render_count ?? 0} renders
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {creating && (
        <CreateProjectModal onClose={() => setCreating(false)} />
      )}

      {digestOpen && (
        <DigestModal onClose={() => setDigestOpen(false)} />
      )}
    </div>
  );
}

/**
 * Modal that shows the live project digest — the same text Ask Cadence
 * will include in its system prompt every turn. Useful for sanity-checking
 * that the project state being shipped to the model is what you expect,
 * and for keeping an eye on its size before model calls start happening.
 */
function DigestModal({ onClose }: { onClose: () => void }) {
  const project = useActiveProject((s) => s.project);
  const aiActiveMediaPath = useProject((s) => s.activeMediaPath);
  const media = useProject((s) => s.media);
  const spliceTimeline = useSplicing((s) => s.timeline);
  const splicePlayhead = useSplicing((s) => s.playhead);

  if (!project) return null;
  const mediaByPath = Object.fromEntries(media.map((m) => [m.path, m]));
  const text = digestProject(project, {
    // The switcher lives in the TopBar; we don't know which tab is active
    // from here, so default to "splicing" if there's a timeline, otherwise
    // "ai". Good enough for the preview — Ask Cadence will pass the real
    // value.
    activeView: spliceTimeline.length > 0 ? "splicing" : "ai",
    aiActiveMediaPath,
    mediaByPath,
    spliceTimeline,
    splicePlayhead,
  });

  // Approximate token count (Claude's tokenizer is ~4 chars/token for
  // English prose). Useful for spotting context bloat early.
  const approxTokens = Math.round(text.length / 4);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[640px] max-w-[90vw] max-h-[80vh] rounded-lg border border-border bg-bg-panel shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <div>
            <div className="text-sm font-medium text-text-primary">
              Project digest
            </div>
            <div className="text-[10px] text-text-muted">
              ~{approxTokens} tokens · what Ask Cadence will see
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                void navigator.clipboard.writeText(text);
              }}
              className="h-7 px-2 rounded bg-bg-elevated hover:bg-border text-xs"
              title="Copy to clipboard"
            >
              Copy
            </button>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text-primary text-sm px-1"
            >
              ✕
            </button>
          </div>
        </div>
        <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-text-primary whitespace-pre">
          {text}
        </pre>
      </div>
    </div>
  );
}
