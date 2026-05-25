import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useActiveProject } from "../stores/activeProject";
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
    </div>
  );
}
