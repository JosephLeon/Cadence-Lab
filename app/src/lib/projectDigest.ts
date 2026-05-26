import type {
  Project,
  ProjectRenderHistoryEntry,
  ProjectSource,
  ProjectSpliceClip,
} from "../api/types";
import type { MediaItem } from "../stores/project";
import type { SpliceClip } from "../stores/splicing";
import { absoluteSourcePath } from "./projectPaths";

/**
 * Build a compact text summary of a project — what Ask Cadence should see
 * in its system prompt before every query.
 *
 * Goals:
 *  - **Tight.** Targets ~300–500 tokens for typical projects so most of the
 *    context budget stays available for the model's reasoning + tool use.
 *  - **Stable.** Same project state → same digest. Easy to cache + diff in
 *    logs.
 *  - **Always current.** Computed at call time from the manifest + session
 *    state; no separate "digest store" to keep in sync.
 *
 * Anything that needs *more* depth (the full transcript around a timestamp,
 * the exact classifier output for a pause, etc.) belongs in a tool the
 * model can call, not in the digest.
 */

export interface ProjectDigestSession {
  /** Which top-level tab the user is looking at. */
  activeView: "ai" | "splicing";
  /** Absolute path of the source active in the AI tab, if any. */
  aiActiveMediaPath?: string | null;
  /** Per-source AI state from `useProject.media`, keyed by absolute path. */
  mediaByPath?: Record<string, MediaItem>;
  /** Splicing timeline from `useSplicing` (frontend representation). */
  spliceTimeline?: SpliceClip[];
  /** Splicing playhead position in seconds. */
  splicePlayhead?: number;
}

export function digestProject(
  project: Project,
  session: ProjectDigestSession,
): string {
  const lines: string[] = [];
  lines.push(`PROJECT: ${project.name}`);
  lines.push(
    `ACTIVE_VIEW: ${session.activeView === "ai" ? "AI tab" : "Splicing tab"}`,
  );
  lines.push("");

  // ─── Sources ────────────────────────────────────────────────────────────
  lines.push(`SOURCES (${project.sources.length}):`);
  if (project.sources.length === 0) {
    lines.push("  (none yet)");
  } else {
    for (const s of project.sources) {
      lines.push(`  ${describeSource(project, s, session)}`);
    }
  }
  lines.push("");

  // ─── Renders ────────────────────────────────────────────────────────────
  const renders = [...project.render_history].reverse(); // newest first
  lines.push(
    `RENDERS (${project.render_history.length}${renders.length > 0 ? ", newest first" : ""}):`,
  );
  if (renders.length === 0) {
    lines.push("  (none yet)");
  } else {
    for (const r of renders.slice(0, 12)) {
      lines.push(`  ${describeRender(r)}`);
    }
    if (renders.length > 12) {
      lines.push(`  ... and ${renders.length - 12} older`);
    }
  }
  lines.push("");

  // ─── Active AI source detail ────────────────────────────────────────────
  if (session.activeView === "ai" && session.aiActiveMediaPath) {
    const item = session.mediaByPath?.[session.aiActiveMediaPath];
    if (item) {
      lines.push(`ACTIVE_PIPELINE (${baseName(session.aiActiveMediaPath)}):`);
      lines.push(`  ${describePipeline(item)}`);
      lines.push(`  ${describeAudio(item)}`);
      const overrideCount = Object.keys(item.overrides ?? {}).length;
      if (overrideCount > 0) {
        lines.push(`  user overrides: ${overrideCount}`);
      }
      lines.push("");
    }
  }

  // ─── Splice timeline detail ─────────────────────────────────────────────
  if (session.activeView === "splicing") {
    const timeline = session.spliceTimeline ?? [];
    const total = timeline.reduce((sum, c) => sum + clipDuration(c), 0);
    lines.push(
      `SPLICE_TIMELINE (${timeline.length} clip${timeline.length === 1 ? "" : "s"} · ${fmtTime(total)}):`,
    );
    if (timeline.length === 0) {
      lines.push("  (empty)");
    } else {
      let acc = 0;
      for (let i = 0; i < timeline.length; i++) {
        const c = timeline[i];
        const start = acc;
        acc += clipDuration(c);
        lines.push(`  ${i + 1}. ${describeSpliceClip(c, start, acc)}`);
      }
    }
    if (typeof session.splicePlayhead === "number") {
      const at = findClipAt(timeline, session.splicePlayhead);
      lines.push(
        `PLAYHEAD: ${fmtTime(session.splicePlayhead)}${at ? ` (in clip ${at.index + 1})` : ""}`,
      );
    }
  }

  return lines.join("\n").trim();
}

// ─── Same shape but reads from the on-disk splice clip format. Used when
// we want a digest from manifest state alone (e.g. server-side). ─────────

export function digestProjectFromManifest(
  project: Project,
  activeView: "ai" | "splicing" = "splicing",
): string {
  // Adapt manifest splice clips to the frontend shape for the shared
  // describeSpliceClip path; durations are derivable from start/end.
  const fakeTimeline: SpliceClip[] = project.splice_state.timeline.map(
    (c, i) =>
      c.kind === "video" && c.source_path
        ? {
            kind: "video",
            id: `m${i}`,
            sourcePath: c.source_path,
            sourceStart: c.source_start,
            sourceEnd: c.source_end,
            sourceDuration: 0,
          }
        : { kind: "blank", id: `m${i}`, duration: c.duration },
  );
  return digestProject(project, {
    activeView,
    spliceTimeline: fakeTimeline,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function describeSource(
  project: Project,
  source: ProjectSource,
  session: ProjectDigestSession,
): string {
  const abs = absoluteSourcePath(project, source);
  const item = session.mediaByPath?.[abs];
  const tags: string[] = [];
  if (item?.probe) {
    tags.push(fmtTime(item.probe.duration_seconds));
    if (item.probe.width) {
      tags.push(`${item.probe.width}×${item.probe.height}`);
    }
    if (item.probe.audio_tracks.length) {
      tags.push(`${item.probe.audio_tracks.length}ch`);
    }
  }
  if (source.ref_mode === "external") tags.push("external");
  const active = session.aiActiveMediaPath === abs ? "  [active]" : "";
  return `${baseName(source.path)}${tags.length ? " · " + tags.join(" · ") : ""}${active}`;
}

function describeRender(r: ProjectRenderHistoryEntry): string {
  const ago = relTime(r.timestamp);
  const size = r.size_bytes ? ` · ${fmtBytes(r.size_bytes)}` : "";
  return `${r.id} · ${r.label}${size} · ${ago}`;
}

function describePipeline(item: MediaItem): string {
  const a = item.pipeline.analysisPath ? "✓" : "·";
  const c = item.pipeline.classifiedPath ? "✓" : "·";
  const p = item.pipeline.planPath ? "✓" : "·";
  const r = item.pipeline.renderedPath ? "✓" : "·";
  return `analyze ${a}  classify ${c}  plan ${p}  render ${r}`;
}

function describeAudio(item: MediaItem): string {
  const a = item.audio;
  const enhanceTag =
    a.enhance_speech === "off"
      ? "off"
      : `${a.enhance_speech} (${a.enhance_engine})`;
  const parts = [`enhance=${enhanceTag}`];
  if (a.auto_duck) parts.push(`duck=${a.ducking_db}dB`);
  return `audio: ${parts.join(", ")}`;
}

function describeSpliceClip(
  c: SpliceClip,
  outStart: number,
  outEnd: number,
): string {
  if (c.kind === "blank") {
    return `[${fmtTime(outStart)}-${fmtTime(outEnd)}] blank`;
  }
  const srcRange = `source ${fmtTime(c.sourceStart)}-${fmtTime(c.sourceEnd)}`;
  return `[${fmtTime(outStart)}-${fmtTime(outEnd)}] ${baseName(c.sourcePath)}  (${srcRange})`;
}

function clipDuration(c: SpliceClip): number {
  return c.kind === "video" ? c.sourceEnd - c.sourceStart : c.duration;
}

function findClipAt(
  timeline: SpliceClip[],
  playhead: number,
): { index: number } | null {
  let acc = 0;
  for (let i = 0; i < timeline.length; i++) {
    acc += clipDuration(timeline[i]);
    if (playhead < acc) return { index: i };
  }
  return null;
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtBytes(n: number): string {
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Math.max(0, (Date.now() - t) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Re-export so callers don't reach across modules for these.
export { ProjectSpliceClip };
