import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useActiveProject } from "../stores/activeProject";
import type { ProjectSummary } from "../api/types";

/**
 * Empty-state screen shown when no project is active. The user must pick
 * one or create one before they can do anything else — projects are the
 * scope for all sources, plans, renders, and history.
 */
export function WelcomeScreen() {
  const open = useActiveProject((s) => s.open);
  const error = useActiveProject((s) => s.error);
  const [creating, setCreating] = useState(false);

  // Always refetch on mount so closing a project + returning to welcome
  // (or coming back to the app after creating/deleting elsewhere) shows
  // the current list, not whatever was cached from the previous visit.
  const projectsQuery = useQuery({
    queryKey: ["projects-list"],
    queryFn: () => api.listProjects(),
    staleTime: 0,
    refetchOnMount: "always",
  });

  return (
    <div className="flex-1 flex items-center justify-center bg-bg p-8 min-h-0 overflow-y-auto">
      <div className="w-full max-w-2xl">
        <h1 className="text-2xl font-semibold text-text-primary mb-1">
          Cadence Lab
        </h1>
        <p className="text-text-secondary mb-6">
          Pick up where you left off, or start something new.
        </p>

        {error && (
          <div className="mb-4 text-sm text-rose-400 border border-rose-400/40 bg-rose-400/10 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="block w-full rounded-lg border border-border bg-bg-panel hover:bg-bg-elevated hover:border-accent transition-colors text-left p-5"
          >
            <div className="text-lg font-medium text-text-primary mb-1">
              ＋ New project
            </div>
            <div className="text-xs text-text-muted">
              Start a fresh workspace — sources, renders, and edit history
              live together.
            </div>
          </button>

          <section className="rounded-lg border border-border bg-bg-panel p-5">
            <div className="text-lg font-medium text-text-primary mb-2">
              Open recent
            </div>
            {projectsQuery.isLoading ? (
              <div className="text-xs text-text-muted">Loading…</div>
            ) : projectsQuery.data?.projects.length ? (
              <ul className="space-y-1 max-h-64 overflow-y-auto">
                {projectsQuery.data.projects.map((p) => (
                  <ProjectRow
                    key={p.slug}
                    summary={p}
                    onOpen={() => {
                      void open(p.slug).catch((e) => {
                        console.error("[WelcomeScreen] open failed:", e);
                      });
                    }}
                  />
                ))}
              </ul>
            ) : (
              <div className="text-xs text-text-muted">
                No projects yet. Create one to get started.
              </div>
            )}
          </section>
        </div>

        {projectsQuery.data && (
          <div className="mt-6 text-[10px] text-text-muted">
            Projects directory: {projectsQuery.data.root}
          </div>
        )}
      </div>

      {creating && (
        <CreateProjectModal
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function ProjectRow({
  summary,
  onOpen,
}: {
  summary: ProjectSummary;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={(e) => {
          console.log("[ProjectRow] clicked", summary.slug);
          e.stopPropagation();
          onOpen();
        }}
        disabled={summary.broken}
        className="w-full text-left px-2 py-1.5 rounded-md hover:bg-bg-elevated cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <div className="text-sm font-medium text-text-primary truncate">
          {summary.name}
          {summary.broken && (
            <span className="text-rose-400 ml-2 text-xs">(broken)</span>
          )}
        </div>
        <div className="text-[10px] text-text-muted truncate">
          {summary.source_count ?? 0} sources ·{" "}
          {summary.render_count ?? 0} renders
          {summary.modified_at &&
            ` · last touched ${formatRelative(summary.modified_at)}`}
        </div>
      </button>
    </li>
  );
}

/**
 * Loose relative-time formatter — good enough for "last touched 2 days
 * ago" labels without pulling in a date library.
 */
function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diffSec = Math.max(0, (Date.now() - t) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const create = useActiveProject((s) => s.create);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trimmed = name.trim();
  const valid = trimmed.length > 0 && !busy;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setErr(null);
    try {
      await create(trimmed);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[440px] rounded-lg border border-border bg-bg-panel shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-text-primary mb-1">
          New project
        </h3>
        <p className="text-xs text-text-muted mb-3">
          A directory will be created at your projects root to hold all the
          sources, plans, and renders for this work.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1">
            Project name
          </label>
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tutorial Ep 3"
            className="w-full h-9 rounded border border-border bg-bg px-3 text-sm focus:outline-none focus:border-accent"
          />
          {err && (
            <div className="mt-2 text-xs text-rose-400" title={err}>
              {err}
            </div>
          )}
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-8 px-3 rounded bg-bg-elevated hover:bg-border text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid}
              className="h-8 px-4 rounded bg-accent hover:bg-accent/80 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
