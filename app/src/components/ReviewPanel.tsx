import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useProject } from "../stores/project";

/**
 * Per-cut review panel — listen to each Claude decision in context and
 * override it. The killer feature: without this, the user has to trust the
 * LLM blindly. With it, the LLM is an assistant whose decisions are
 * auditable one-by-one.
 *
 * Layout: full-area takeover when open, with a list of every classifier
 * decision sorted by time. Each row shows the action, classifier reason,
 * surrounding transcript context, and a small inline audio clip extracted
 * lazily from the mic WAV via /audio-clip.
 */

interface PauseRow {
  kind: "pause";
  id: number;
  start: number;
  end: number;
  category: string;
  action: "cut" | "trim" | "keep";
  reason: string;
}
interface FillerRow {
  kind: "filler";
  id: number;
  text: string;
  start: number;
  end: number;
  action: "cut" | "keep";
  reason: string;
}
interface RetakeRow {
  kind: "retake";
  id: number; // index into retakes array
  cutStart: number;
  cutEnd: number;
  keepStart: number;
  keepEnd: number;
  reason: string;
}
type Row = PauseRow | FillerRow | RetakeRow;

type Filter =
  | "all-non-keep"
  | "pauses-only"
  | "fillers-only"
  | "retakes-only"
  | "my-overrides"
  | "everything";

const FILTER_LABELS: Record<Filter, string> = {
  "all-non-keep": "All non-keep",
  "pauses-only": "Pauses only",
  "fillers-only": "Fillers only",
  "retakes-only": "Retakes only",
  "my-overrides": "My overrides only",
  everything: "Everything",
};

const PAGE_SIZE = 20;

function fmtClock(s: number): string {
  if (!Number.isFinite(s)) return "?";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

interface Props {
  onClose: () => void;
}

export function ReviewPanel({ onClose }: Props) {
  const active = useProject((s) => s.activeMediaPath);
  const item = useProject((s) =>
    s.media.find((m) => m.path === active),
  );
  const overrides = item?.overrides ?? {};
  const setOverride = useProject((s) => s.setOverride);
  const clearOverrides = useProject((s) => s.clearOverrides);
  const setMediaState = useProject((s) => s.updateMedia);

  const [filter, setFilter] = useState<Filter>("all-non-keep");
  const [page, setPage] = useState(0);
  const [applying, setApplying] = useState(false);
  const [previewDuration, setPreviewDuration] = useState<number | null>(null);
  const qc = useQueryClient();

  const classifiedPath = item?.pipeline.classifiedPath;
  const analysisPath = item?.pipeline.analysisPath;
  const micWavPath = item?.pipeline.micWavPath;

  const cls = useQuery({
    queryKey: ["classification", classifiedPath],
    queryFn: () => api.getClassification(classifiedPath!),
    enabled: !!classifiedPath,
  });

  // Original plan duration to compare against override preview.
  const currentPlan = useQuery({
    queryKey: ["plan-bundle", item?.pipeline.planPath],
    queryFn: () => api.getPlan(item!.pipeline.planPath!),
    enabled: !!item?.pipeline.planPath,
  });

  // Live preview: how much would the override set change output duration?
  // Recomputes on every override change (cheap — plan_cuts is sync interval algebra).
  const overrideCount = Object.keys(overrides).length;
  const previewQuery = useQuery({
    queryKey: ["plan-preview", analysisPath, classifiedPath, overrides],
    queryFn: async () => {
      const res = await api.plan({
        analysis_path: analysisPath!,
        classified_path: classifiedPath!,
        overrides,
      });
      return res.plan;
    },
    enabled: !!analysisPath && !!classifiedPath && overrideCount > 0,
    staleTime: 30_000,
  });
  // Cache the preview duration so it doesn't blink to "—" between refetches.
  if (
    previewQuery.data &&
    previewQuery.data.output_duration !== previewDuration
  ) {
    setPreviewDuration(previewQuery.data.output_duration);
  }
  if (overrideCount === 0 && previewDuration !== null) {
    setPreviewDuration(null);
  }

  const rows: Row[] = useMemo(() => {
    if (!cls.data) return [];
    const out: Row[] = [];
    const pauseById = new Map(
      cls.data.pause_candidates.map((p) => [p.id, p]),
    );
    const fillerById = new Map(
      cls.data.filler_candidates.map((f) => [f.id, f]),
    );

    for (const p of cls.data.classification.pauses) {
      const cand = pauseById.get(p.id);
      if (!cand) continue;
      out.push({
        kind: "pause",
        id: p.id,
        start: cand.start,
        end: cand.end,
        category: p.category,
        action: p.action,
        reason: p.reason,
      });
    }
    for (const f of cls.data.classification.fillers) {
      const cand = fillerById.get(f.id);
      if (!cand) continue;
      out.push({
        kind: "filler",
        id: f.id,
        text: cand.text,
        start: cand.start,
        end: cand.end,
        action: f.action,
        reason: f.reason,
      });
    }
    cls.data.classification.retakes.forEach((r, i) => {
      out.push({
        kind: "retake",
        id: i,
        cutStart: r.cut_start,
        cutEnd: r.cut_end,
        keepStart: r.keep_start,
        keepEnd: r.keep_end,
        reason: r.reason,
      });
    });
    out.sort((a, b) => {
      const aStart = a.kind === "retake" ? a.cutStart : a.start;
      const bStart = b.kind === "retake" ? b.cutStart : b.start;
      return aStart - bStart;
    });
    return out;
  }, [cls.data]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      const key = `${r.kind}:${r.id}`;
      switch (filter) {
        case "all-non-keep":
          if (r.kind === "retake") return true;
          return r.action !== "keep";
        case "pauses-only":
          return r.kind === "pause";
        case "fillers-only":
          return r.kind === "filler";
        case "retakes-only":
          return r.kind === "retake";
        case "my-overrides":
          return key in overrides;
        case "everything":
          return true;
      }
    });
  }, [rows, filter, overrides]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );

  const handleApply = async () => {
    if (!analysisPath || !classifiedPath || !item) return;
    setApplying(true);
    try {
      const res = await api.plan({
        analysis_path: analysisPath,
        classified_path: classifiedPath,
        overrides,
      });
      // Update pipeline.planPath in store + invalidate the plan-bundle
      // query so Timeline picks up the new keeps + cuts immediately.
      setMediaState(item.path, {
        pipeline: { ...item.pipeline, planPath: res.plan_path },
      });
      qc.invalidateQueries({ queryKey: ["plan-bundle"] });
      // An earlier render is now stale.
      setMediaState(item.path, {
        pipeline: { ...item.pipeline, planPath: res.plan_path, renderedPath: undefined },
      });
      clearOverrides(item.path);
      setPreviewDuration(null);
    } finally {
      setApplying(false);
    }
  };

  if (!item) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted">
        Select a clip first.
      </div>
    );
  }

  if (!classifiedPath) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted">
        <div className="text-center max-w-sm">
          <div className="text-sm">No classification yet for this clip.</div>
          <div className="text-xs mt-1">
            Run Analyze and Classify from the AI Controls panel first.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-bg-panel">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-4 py-3 flex items-center gap-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Review &amp; refine
        </h2>
        <span className="text-xs text-text-muted">
          {item.path.split("/").pop()}
        </span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="text-xs px-2 py-1 text-text-secondary hover:text-text-primary rounded-md transition-colors"
          title="Close (Esc)"
        >
          ✕ Close
        </button>
      </div>

      {/* Toolbar */}
      <div className="shrink-0 border-b border-border px-4 py-2 flex items-center gap-3">
        <label className="text-[10px] uppercase tracking-wider text-text-muted">
          Show
        </label>
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as Filter);
            setPage(0);
          }}
          className="h-7 px-2 rounded-md border border-border bg-bg text-xs focus:outline-none focus:border-accent"
        >
          {Object.entries(FILTER_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>

        <div className="flex-1" />

        {/* Override count + preview */}
        <div className="text-xs text-text-secondary">
          <span className="font-semibold text-text-primary">
            {overrideCount}
          </span>{" "}
          override{overrideCount === 1 ? "" : "s"}
        </div>
        {overrideCount > 0 && previewDuration !== null && currentPlan.data && (
          <span className="text-xs text-text-secondary">
            preview:{" "}
            <span className="font-mono text-text-primary">
              {fmtClock(previewDuration)}
            </span>
            {(() => {
              const delta =
                previewDuration - currentPlan.data.output_duration;
              const sign = delta >= 0 ? "+" : "−";
              return (
                <span
                  className={
                    delta >= 0
                      ? "text-emerald-400 ml-1"
                      : "text-rose-400 ml-1"
                  }
                >
                  ({sign}
                  {fmtClock(Math.abs(delta))})
                </span>
              );
            })()}
          </span>
        )}

        <button
          onClick={() => item && clearOverrides(item.path)}
          disabled={overrideCount === 0 || applying}
          className="h-7 px-2 text-xs rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-elevated disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Reset
        </button>
        <button
          onClick={handleApply}
          disabled={overrideCount === 0 || applying}
          className="h-7 px-3 text-xs rounded-md bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-colors"
        >
          {applying ? "Applying…" : "Apply & re-plan"}
        </button>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto">
        {cls.isLoading && (
          <div className="p-8 text-center text-sm text-text-muted">
            Loading classification…
          </div>
        )}
        {cls.error && (
          <div className="p-8 text-center text-sm text-rose-400">
            Failed to load classification.
          </div>
        )}
        {cls.data && filtered.length === 0 && (
          <div className="p-8 text-center text-sm text-text-muted">
            No items match the current filter.
          </div>
        )}
        {pageRows.map((r) => {
          const key = `${r.kind}:${r.id}`;
          const override = overrides[key];
          return (
            <ReviewRow
              key={key}
              row={r}
              currentOverride={override}
              micWavPath={micWavPath}
              onOverride={(value) =>
                item && setOverride(item.path, key, value)
              }
            />
          );
        })}
      </div>

      {/* Pagination */}
      {filtered.length > PAGE_SIZE && (
        <div className="shrink-0 border-t border-border px-4 py-2 flex items-center gap-2 text-xs">
          <button
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
            className="h-6 px-2 rounded-md hover:bg-bg-elevated disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ← Prev
          </button>
          <span className="text-text-secondary">
            {currentPage * PAGE_SIZE + 1}–
            {Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of{" "}
            {filtered.length}
          </span>
          <button
            disabled={currentPage >= totalPages - 1}
            onClick={() => setPage(currentPage + 1)}
            className="h-6 px-2 rounded-md hover:bg-bg-elevated disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next →
          </button>
          <div className="flex-1" />
          <span className="text-text-muted">
            page {currentPage + 1} / {totalPages}
          </span>
        </div>
      )}
    </div>
  );
}

interface RowProps {
  row: Row;
  currentOverride: string | undefined;
  micWavPath?: string;
  onOverride: (value: string | null) => void;
}

function ReviewRow({ row, currentOverride, micWavPath, onOverride }: RowProps) {
  const [showAudio, setShowAudio] = useState(false);

  const effective = currentOverride ?? (row.kind === "retake" ? "accept" : row.action);
  const isOverridden = currentOverride !== undefined;

  // Audio span — for retakes, play the cut + keep ranges together.
  const audioStart = row.kind === "retake" ? row.cutStart : row.start;
  const audioEnd = row.kind === "retake" ? row.keepEnd : row.end;

  const icon =
    effective === "keep" || effective === "accept"
      ? "•"
      : effective === "trim"
      ? "≈"
      : "✂";

  let label = "";
  let detail = "";
  if (row.kind === "pause") {
    const dur = ((row.end - row.start) * 1000).toFixed(0);
    label = `${fmtClock(row.start)}  pause ${dur}ms`;
    detail = `${row.category} — ${row.reason}`;
  } else if (row.kind === "filler") {
    label = `${fmtClock(row.start)}  filler "${row.text}"`;
    detail = row.reason;
  } else {
    const dur = ((row.cutEnd - row.cutStart) * 1000).toFixed(0);
    label = `${fmtClock(row.cutStart)}  retake — drop ${dur}ms`;
    detail = row.reason;
  }

  // Action options per kind
  const options =
    row.kind === "pause"
      ? (["cut", "trim", "keep"] as const)
      : row.kind === "filler"
      ? (["cut", "keep"] as const)
      : (["accept", "reject"] as const);

  return (
    <div
      className={
        "border-b border-border-subtle px-4 py-3 " +
        (isOverridden ? "bg-accent/5" : "")
      }
    >
      <div className="flex items-start gap-3">
        <span className="text-base shrink-0 w-4 text-center text-text-secondary mt-0.5">
          {icon}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium font-mono">{label}</span>
            {isOverridden && (
              <span className="text-[10px] text-accent">
                ⟵ overridden
              </span>
            )}
          </div>
          <div className="text-xs text-text-secondary mt-0.5 truncate">
            {detail}
          </div>

          {showAudio && micWavPath && (
            <audio
              key={`${audioStart}-${audioEnd}`}
              src={api.audioClipUrl(micWavPath, audioStart, audioEnd)}
              controls
              preload="auto"
              autoPlay
              className="mt-2 w-full h-7"
            />
          )}
        </div>

        <div className="shrink-0 flex items-center gap-1">
          {micWavPath && (
            <button
              onClick={() => setShowAudio((v) => !v)}
              className="h-7 px-2 text-xs rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors"
            >
              {showAudio ? "Hide" : "▶ Listen"}
            </button>
          )}

          <div className="flex rounded-md border border-border overflow-hidden">
            {options.map((opt) => {
              const isActive = effective === opt;
              const isDefault =
                opt ===
                (row.kind === "retake" ? "accept" : row.action);
              return (
                <button
                  key={opt}
                  onClick={() => {
                    // Clicking the classifier's original choice clears the
                    // override. Clicking anything else sets it.
                    onOverride(isDefault ? null : opt);
                  }}
                  className={
                    "px-2 py-1 text-xs font-medium transition-colors " +
                    (isActive
                      ? opt === "cut" || opt === "reject"
                        ? "bg-rose-500/20 text-rose-300"
                        : opt === "trim"
                        ? "bg-amber-500/20 text-amber-300"
                        : "bg-emerald-500/20 text-emerald-300"
                      : "bg-bg text-text-secondary hover:bg-bg-elevated")
                  }
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
