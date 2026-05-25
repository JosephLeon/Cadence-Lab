import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useSplicing,
  clipAtPlayhead,
  clipDuration,
  totalDuration,
  type SpliceClip,
} from "../stores/splicing";
import { spliceVideoRef } from "../stores/spliceVideoRef";
import { api } from "../api/client";
import type { JobEvent } from "../api/types";
import { MediaAddPanel, type MediaManager } from "./MediaAddPanel";

const DRAG_MIME = "application/x-cadence-splice";

function fmtDuration(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Splicing view — load multiple clips on a shared timeline, reorder + split
 * them, preview the assembled output. Its media library is independent of
 * the AI Processing tab.
 */
export function SplicingView() {
  // Spacebar play/pause, split-at-playhead (`b` for blade — video-editor
  // convention), and Delete/Backspace to remove the current selection.
  // Wired at the view root so it works regardless of focus.
  const splitAtPlayhead = useSplicing((s) => s.splitAtPlayhead);
  const removeSelected = useSplicing((s) => s.removeSelected);
  const clearSelection = useSplicing((s) => s.clearSelection);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === " ") {
        e.preventDefault();
        const st = useSplicing.getState();
        const at = clipAtPlayhead(st.timeline, st.playhead);
        // On a video clip, drive the underlying <video>. On a blank (or
        // empty timeline), toggle the store's isPlaying so the wall-clock
        // timer in Preview advances the playhead through the black span.
        if (at && at.clip.kind === "video") {
          const v = spliceVideoRef.current;
          if (!v) return;
          if (v.paused) v.play().catch(() => {});
          else v.pause();
        } else if (at) {
          st.setPlaying(!st.isPlaying);
        }
      } else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        splitAtPlayhead();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removeSelected();
      } else if (e.key === "Escape") {
        clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [splitAtPlayhead, removeSelected, clearSelection]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 flex min-h-0">
        <MediaList />
        <Preview />
      </div>
      <SpliceTimeline />
    </div>
  );
}

// ─── Media list (left column) ─────────────────────────────────────────────────

function MediaList() {
  const library = useSplicing((s) => s.library);
  const addMedia = useSplicing((s) => s.addMedia);
  const updateMedia = useSplicing((s) => s.updateMedia);
  const removeMedia = useSplicing((s) => s.removeMedia);

  const manager: MediaManager = {
    add: (path) => addMedia(path),
    setProbed: (path, probe, paths) =>
      updateMedia(path, { probe, canonical: paths, status: "ready" }),
    setError: (path, error) => updateMedia(path, { status: "error", error }),
  };

  return (
    <aside className="w-72 shrink-0 border-r border-border bg-bg-panel flex flex-col">
      <div className="h-10 shrink-0 border-b border-border flex items-center px-3">
        <h2 className="text-sm font-medium text-text-secondary uppercase tracking-wider">
          Media
        </h2>
      </div>
      <MediaAddPanel manager={manager} />
      <div className="flex-1 overflow-y-auto p-2">
        {library.length === 0 ? (
          <div className="p-4 text-sm text-text-muted text-center">
            Add a video above, then drag it onto the timeline.
          </div>
        ) : (
          <ul className="space-y-1">
            {library.map((m) => {
              const name = m.path.split("/").pop() ?? m.path;
              const ready = m.status === "ready" && m.probe;
              return (
                <li
                  key={m.path}
                  draggable={!!ready}
                  onDragStart={(e) => {
                    if (!ready || !m.probe) return;
                    e.dataTransfer.effectAllowed = "copy";
                    e.dataTransfer.setData(
                      DRAG_MIME,
                      JSON.stringify({
                        kind: "media",
                        sourcePath: m.path,
                        duration: m.probe.duration_seconds,
                      }),
                    );
                  }}
                  className={
                    "group rounded-md px-2 py-2 border " +
                    (ready
                      ? "border-transparent hover:bg-bg-elevated cursor-grab active:cursor-grabbing"
                      : "border-transparent opacity-50")
                  }
                  title={ready ? "Drag to timeline" : "Probe still running"}
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
                      title="Remove from splicing library"
                    >
                      ✕
                    </button>
                  </div>
                  {ready && m.probe && (
                    <div className="mt-1 flex gap-3 text-xs text-text-secondary">
                      <span>{fmtDuration(m.probe.duration_seconds)}</span>
                      {m.probe.width && (
                        <span>
                          {m.probe.width}×{m.probe.height}
                        </span>
                      )}
                    </div>
                  )}
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
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

// ─── Preview (center) ─────────────────────────────────────────────────────────

function Preview() {
  const timeline = useSplicing((s) => s.timeline);
  const playhead = useSplicing((s) => s.playhead);
  const setPlayhead = useSplicing((s) => s.setPlayhead);
  const isPlaying = useSplicing((s) => s.isPlaying);
  const setPlaying = useSplicing((s) => s.setPlaying);

  const at = clipAtPlayhead(timeline, playhead);
  const total = totalDuration(timeline);

  const onVideoClip = at && at.clip.kind === "video";
  const currentSrc = onVideoClip ? api.sourceUrl(at!.clip.sourcePath) : null;
  const lastSrcRef = useRef<string | null>(null);

  // Seek + swap source whenever the underlying clip changes. Only meaningful
  // for video clips — blank clips have no video element.
  useEffect(() => {
    const el = spliceVideoRef.current;
    if (!el || !at || at.clip.kind !== "video") return;
    const target = at.clip.sourceStart + at.offset;
    if (lastSrcRef.current !== currentSrc) {
      lastSrcRef.current = currentSrc;
      const onLoaded = () => {
        el.currentTime = target;
        el.removeEventListener("loadedmetadata", onLoaded);
      };
      el.addEventListener("loadedmetadata", onLoaded);
      return;
    }
    if (Math.abs(el.currentTime - target) > 0.1) {
      el.currentTime = target;
    }
  }, [currentSrc, at]);

  // Wall-clock timer that drives the playhead through blank clips when
  // playback is active. Real video clips use the <video> element's own
  // timeupdate to advance.
  useEffect(() => {
    if (!isPlaying || !at || at.clip.kind !== "blank") return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const next = useSplicing.getState().playhead + dt;
      const tot = totalDuration(useSplicing.getState().timeline);
      if (next >= tot) {
        useSplicing.getState().setPlayhead(tot);
        useSplicing.getState().setPlaying(false);
        return;
      }
      useSplicing.getState().setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, at?.clip.id, at?.clip.kind]);

  // Auto-advance: when video playback runs past the current clip's
  // sourceEnd, jump the global playhead to the next clip's start.
  const onTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!at || at.clip.kind !== "video") return;
    const el = e.currentTarget;
    if (el.currentTime >= at.clip.sourceEnd - 0.02) {
      const nextClipStart = at.clipStart + clipDuration(at.clip);
      if (nextClipStart < total) {
        setPlayhead(nextClipStart + 0.001);
      } else {
        el.pause();
        setPlayhead(total);
      }
      return;
    }
    setPlayhead(at.clipStart + (el.currentTime - at.clip.sourceStart));
  };

  return (
    <main className="flex-1 flex flex-col min-w-0 bg-bg-elevated">
      <div className="flex-1 flex items-center justify-center min-h-0 p-4">
        {at && at.clip.kind === "video" ? (
          <video
            ref={(el) => {
              spliceVideoRef.current = el;
            }}
            src={currentSrc ?? undefined}
            controls
            className="max-w-full max-h-full rounded-md shadow-lg bg-black"
            onTimeUpdate={onTimeUpdate}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        ) : at && at.clip.kind === "blank" ? (
          <div className="w-full max-w-3xl aspect-video bg-black rounded-md shadow-lg flex items-center justify-center text-text-muted text-xs">
            (blank · {fmtDuration(at.clip.duration)})
          </div>
        ) : (
          <div className="text-text-muted text-sm text-center">
            Drag clips from the left panel onto the timeline below.
            <div className="mt-2 text-xs">
              Space: play/pause · B: split · ⌫: delete · Cmd+wheel: zoom
            </div>
          </div>
        )}
      </div>
      <div className="h-10 shrink-0 border-t border-border flex items-center px-4 text-xs text-text-secondary gap-3">
        <span className="font-mono">
          {fmtDuration(playhead)} / {fmtDuration(total)}
        </span>
        {at && (
          <span className="truncate text-text-muted flex-1">
            clip {at.index + 1} of {timeline.length} ·{" "}
            {at.clip.kind === "video"
              ? at.clip.sourcePath.split("/").pop()
              : "blank"}
          </span>
        )}
        {!at && <div className="flex-1" />}
        <ExportButton />
      </div>
    </main>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

function ExportButton() {
  const timeline = useSplicing((s) => s.timeline);
  const library = useSplicing((s) => s.library);
  const [job, setJob] = useState<
    | { status: "idle" }
    | { status: "naming" }
    | { status: "running"; progress: number; message: string }
    | { status: "done"; outputName: string; outputPath: string }
    | { status: "error"; error: string }
  >({ status: "idle" });

  const total = totalDuration(timeline);
  const disabled =
    timeline.length === 0 ||
    job.status === "running" ||
    job.status === "naming";

  // Pick reasonable defaults for target geometry: use the largest probed
  // dimensions in the library so we don't downscale anyone.
  const targetWidth = Math.max(
    1920,
    ...library
      .map((m) => m.probe?.width ?? 0)
      .filter((n): n is number => Number.isFinite(n)),
  );
  const targetHeight = Math.max(
    1080,
    ...library
      .map((m) => m.probe?.height ?? 0)
      .filter((n): n is number => Number.isFinite(n)),
  );

  const beginExport = async (name: string) => {
    setJob({ status: "running", progress: 0, message: "Submitting…" });
    try {
      const handle = await api.spliceRender({
        output_name: name,
        target_width: targetWidth,
        target_height: targetHeight,
        clips: timeline.map((c) =>
          c.kind === "video"
            ? {
                kind: "video",
                source_path: c.sourcePath,
                source_start: c.sourceStart,
                source_end: c.sourceEnd,
              }
            : { kind: "blank", duration: c.duration },
        ),
      });
      const unsub = api.subscribeJob(
        handle.job_id,
        (ev: JobEvent) => {
          if (ev._terminal) {
            unsub();
            void api.getJob(handle.job_id).then((j) => {
              if (j.status === "done") {
                const r = j.result as
                  | { output_name?: string; output_path?: string }
                  | null;
                setJob({
                  status: "done",
                  outputName: r?.output_name ?? `${name}.mp4`,
                  outputPath: r?.output_path ?? "",
                });
              } else {
                setJob({
                  status: "error",
                  error: j.error ?? "Export failed",
                });
              }
            });
            return;
          }
          if (typeof ev.progress === "number") {
            setJob({
              status: "running",
              progress: ev.progress,
              message: ev.message ?? "",
            });
          }
        },
        () => setJob({ status: "error", error: "Lost connection to server" }),
      );
    } catch (e) {
      setJob({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  if (job.status === "running") {
    return (
      <div className="flex items-center gap-2 min-w-[220px]">
        <div className="flex-1 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
          <div
            className="h-full bg-accent transition-all duration-150"
            style={{ width: `${Math.max(2, job.progress * 100)}%` }}
          />
        </div>
        <span className="font-mono text-text-muted shrink-0">
          {Math.round(job.progress * 100)}%
        </span>
      </div>
    );
  }
  if (job.status === "done") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-emerald-400 truncate" title={job.outputPath}>
          ✓ {job.outputName}
        </span>
        <button
          onClick={() => setJob({ status: "idle" })}
          className="h-7 px-2 rounded bg-bg-elevated hover:bg-border text-xs"
        >
          Export again
        </button>
      </div>
    );
  }
  if (job.status === "error") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-rose-400 truncate" title={job.error}>
          ✗ {job.error}
        </span>
        <button
          onClick={() => setJob({ status: "idle" })}
          className="h-7 px-2 rounded bg-bg-elevated hover:bg-border text-xs"
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <>
      <button
        onClick={() => setJob({ status: "naming" })}
        disabled={disabled}
        className="h-7 px-3 rounded bg-accent hover:bg-accent/80 text-white text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        title={
          disabled && timeline.length === 0
            ? "Add clips to the timeline first"
            : `Export ${fmtDuration(total)} assembly`
        }
      >
        ▶ Export MP4
      </button>
      {job.status === "naming" && (
        <ExportNameDialog
          onCancel={() => setJob({ status: "idle" })}
          onConfirm={(name) => beginExport(name)}
        />
      )}
    </>
  );
}

function ExportNameDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  // Default filename: splice_YYYY-MM-DD-HH-MM-SS, recomputed once per
  // dialog open.
  const [name, setName] = useState(() => {
    const ts = new Date()
      .toISOString()
      .replace(/[:T]/g, "-")
      .slice(0, 19);
    return `splice_${ts}`;
  });
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const trimmed = name.trim();
  const valid = trimmed.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="w-[420px] rounded-lg border border-border bg-bg-panel shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-text-primary mb-1">
          Export assembled video
        </h3>
        <p className="text-xs text-text-muted mb-3">
          Saved to the files directory as ".mp4".
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onConfirm(trimmed);
          }}
        >
          <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1">
            Filename
          </label>
          <div className="flex items-center gap-1">
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 h-9 rounded border border-border bg-bg px-3 text-sm focus:outline-none focus:border-accent"
              placeholder="my_export"
            />
            <span className="text-text-muted text-sm">.mp4</span>
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-8 px-3 rounded bg-bg-elevated hover:bg-border text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid}
              className="h-8 px-4 rounded bg-accent hover:bg-accent/80 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Export
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Timeline (bottom) ────────────────────────────────────────────────────────

const ZOOM_STORAGE_KEY = "cadence-lab:splice-timeline-zoom";
const ZOOM_DEFAULT = 30; // pixels per second
const ZOOM_MIN = 5;
const ZOOM_MAX = 400;
const ZOOM_WHEEL_STEP = 1.1;

const HEIGHT_STORAGE_KEY = "cadence-lab:splice-timeline-height";
const HEIGHT_MIN = 120;
const HEIGHT_DEFAULT = 200;
const HEIGHT_MAX_FRAC = 0.7;

/** Padding on either side of the timeline content so the user can scroll
 *  slightly past the start and end of the assembled video. */
const TIMELINE_PADDING_PX = 240;

function clampHeight(h: number): number {
  const max = Math.max(HEIGHT_MIN, Math.floor(window.innerHeight * HEIGHT_MAX_FRAC));
  return Math.min(Math.max(h, HEIGHT_MIN), max);
}

function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return ZOOM_DEFAULT;
  return Math.min(Math.max(z, ZOOM_MIN), ZOOM_MAX);
}

function loadHeight(): number {
  try {
    const raw = localStorage.getItem(HEIGHT_STORAGE_KEY);
    if (raw) return clampHeight(Number(raw));
  } catch {
    /* ignore */
  }
  return HEIGHT_DEFAULT;
}

function loadZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (raw) return clampZoom(Number(raw));
  } catch {
    /* ignore */
  }
  return ZOOM_DEFAULT;
}

/** Ruler tick spacing — picks a "nice" interval from this scale that
 *  produces ~120px between ticks at the current zoom. */
const TICK_SCALE_SEC = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
function pickTickInterval(pxPerSec: number, targetPx = 120): number {
  for (const s of TICK_SCALE_SEC) {
    if (s * pxPerSec >= targetPx) return s;
  }
  return TICK_SCALE_SEC[TICK_SCALE_SEC.length - 1];
}

const RULER_HEIGHT = 22;

function SpliceTimeline() {
  const timeline = useSplicing((s) => s.timeline);
  const playhead = useSplicing((s) => s.playhead);
  const addClip = useSplicing((s) => s.addClip);
  const moveClip = useSplicing((s) => s.moveClip);
  const setPlayhead = useSplicing((s) => s.setPlayhead);
  const splitAtPlayhead = useSplicing((s) => s.splitAtPlayhead);
  const clearSelection = useSplicing((s) => s.clearSelection);
  const selectedCount = useSplicing((s) => s.selectedIds.length);

  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [height, setHeight] = useState<number>(loadHeight);
  const [pxPerSecond, setPxPerSecond] = useState<number>(loadZoom);
  const [contextMenu, setContextMenu] = useState<
    { clipId: string; x: number; y: number } | null
  >(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  const openContextMenu = (e: React.MouseEvent, clipId: string) => {
    e.preventDefault();
    setContextMenu({ clipId, x: e.clientX, y: e.clientY });
  };

  useEffect(() => {
    try {
      localStorage.setItem(HEIGHT_STORAGE_KEY, String(height));
    } catch {
      /* ignore */
    }
  }, [height]);

  useEffect(() => {
    try {
      localStorage.setItem(ZOOM_STORAGE_KEY, String(pxPerSecond));
    } catch {
      /* ignore */
    }
  }, [pxPerSecond]);

  // Resize from top edge.
  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = height;
      const onMove = (ev: PointerEvent) => {
        setHeight(clampHeight(startH + (startY - ev.clientY)));
      };
      const onUp = (ev: PointerEvent) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    },
    [height],
  );

  // Cmd/Ctrl + wheel = zoom, anchored at the cursor position so the
  // underlying time-point stays put. Plain wheel = native horizontal scroll.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      const rect = strip.getBoundingClientRect();
      const xInStrip = e.clientX - rect.left + strip.scrollLeft;
      const timeUnderCursor = (xInStrip - TIMELINE_PADDING_PX) / pxPerSecond;
      const factor = e.deltaY < 0 ? ZOOM_WHEEL_STEP : 1 / ZOOM_WHEEL_STEP;
      const next = clampZoom(pxPerSecond * factor);
      setPxPerSecond(next);
      // After the layout updates, restore the cursor's time anchor.
      requestAnimationFrame(() => {
        const newX = timeUnderCursor * next + TIMELINE_PADDING_PX;
        strip.scrollLeft = newX - (e.clientX - rect.left);
      });
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [pxPerSecond]);

  const indexForX = (clientX: number): number => {
    const strip = stripRef.current;
    if (!strip) return timeline.length;
    const blocks = Array.from(
      strip.querySelectorAll<HTMLElement>("[data-clip-index]"),
    );
    for (let i = 0; i < blocks.length; i++) {
      const rect = blocks[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return timeline.length;
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIndex(indexForX(e.clientX));
  };

  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDragOverIndex(null);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverIndex(null);
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    const payload = JSON.parse(raw) as
      | { kind: "media"; sourcePath: string; duration: number }
      | { kind: "clip"; id: string };
    const insertAt = indexForX(e.clientX);
    if (payload.kind === "media") {
      addClip(payload.sourcePath, payload.duration, insertAt);
    } else {
      moveClip(payload.id, insertAt);
    }
  };

  const total = totalDuration(timeline);
  const contentWidth = total * pxPerSecond + TIMELINE_PADDING_PX * 2;
  const playheadX = TIMELINE_PADDING_PX + Math.min(playhead, total) * pxPerSecond;
  const atPlayhead = clipAtPlayhead(timeline, playhead);
  const canSplit =
    !!atPlayhead &&
    atPlayhead.offset > 0.05 &&
    atPlayhead.offset < clipDuration(atPlayhead.clip) - 0.05;

  return (
    <div
      className="border-t border-border bg-bg-panel flex flex-col relative"
      style={{ height }}
    >
      <div
        onPointerDown={onResizeStart}
        className="absolute left-0 right-0 -top-1 h-2 cursor-row-resize z-20 hover:bg-accent/40 transition-colors"
        title="Drag to resize timeline"
      />
      <div className="h-7 shrink-0 border-b border-border flex items-center px-3 text-xs text-text-secondary justify-between gap-2">
        <span className="uppercase tracking-wider font-medium">
          Splice timeline
        </span>
        <div className="flex items-center gap-3">
          {selectedCount > 0 && (
            <span className="text-accent">
              {selectedCount} selected · ⌫ to delete
            </span>
          )}
          <button
            disabled={!canSplit}
            onClick={() => splitAtPlayhead()}
            className="h-6 px-2 rounded bg-bg-elevated hover:bg-border text-xs disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
            title="Split clip at playhead (B)"
          >
            ✂︎ Split
          </button>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPxPerSecond((p) => clampZoom(p / 1.25))}
              className="h-6 w-6 rounded bg-bg-elevated hover:bg-border text-xs"
              title="Zoom out"
            >
              −
            </button>
            <span className="font-mono text-text-muted tabular-nums w-12 text-center">
              {pxPerSecond.toFixed(0)}px/s
            </span>
            <button
              onClick={() => setPxPerSecond((p) => clampZoom(p * 1.25))}
              className="h-6 w-6 rounded bg-bg-elevated hover:bg-border text-xs"
              title="Zoom in"
            >
              +
            </button>
          </div>
          <span className="text-text-muted">
            {timeline.length} clip{timeline.length === 1 ? "" : "s"} ·{" "}
            {fmtDuration(total)}
          </span>
        </div>
      </div>
      <div
        ref={stripRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className="flex-1 overflow-x-auto overflow-y-hidden relative"
      >
        {/* Inner content sized to the assembled duration + padding so
            horizontal scroll covers both the ruler and the clip row. */}
        <div
          className="relative h-full"
          style={{ width: contentWidth }}
          onClick={(e) => {
            // Click on truly empty area (not the ruler, not a clip block)
            // clears selection.
            if (e.target === e.currentTarget) clearSelection();
          }}
        >
          {/* Ruler — owns playhead clicks and shows time labels */}
          <Ruler
            pxPerSecond={pxPerSecond}
            total={total}
            playheadX={playheadX}
            onSeek={(timeSec) => {
              setPlayhead(Math.max(0, Math.min(timeSec, total)));
            }}
          />

          {timeline.length === 0 ? (
            <div
              className="absolute left-0 right-0 flex items-center justify-center text-text-muted text-sm pointer-events-none"
              style={{ top: RULER_HEIGHT, bottom: 0 }}
            >
              Drag clips here to assemble your video
            </div>
          ) : (
            <div
              className="absolute left-0 right-0 flex items-stretch"
              style={{
                top: RULER_HEIGHT,
                bottom: 0,
                paddingLeft: TIMELINE_PADDING_PX,
                paddingRight: TIMELINE_PADDING_PX,
              }}
            >
              {timeline.map((c, i) => (
                <ClipBlock
                  key={c.id}
                  clip={c}
                  index={i}
                  pxPerSecond={pxPerSecond}
                  highlight={dragOverIndex === i}
                  onContextMenu={openContextMenu}
                />
              ))}
              {dragOverIndex === timeline.length && (
                <div className="w-1 bg-accent shrink-0" />
              )}
            </div>
          )}

          {/* Playhead spans both ruler and clip row. */}
          {total > 0 && (
            <div
              className="absolute top-0 bottom-0 w-px bg-accent pointer-events-none z-10"
              style={{ left: playheadX }}
            >
              <div className="w-3 h-3 bg-accent rounded-full -translate-x-1/2 -translate-y-1/2" />
            </div>
          )}
        </div>
      </div>

      {contextMenu && (
        <ClipContextMenu
          clipId={contextMenu.clipId}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function ClipContextMenu({
  clipId,
  x,
  y,
  onClose,
}: {
  clipId: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const timeline = useSplicing((s) => s.timeline);
  const lastSpaceSeconds = useSplicing((s) => s.lastSpaceSeconds);
  const setLastSpaceSeconds = useSplicing((s) => s.setLastSpaceSeconds);
  const addBlank = useSplicing((s) => s.addBlank);
  const removeClip = useSplicing((s) => s.removeClip);

  const [seconds, setSeconds] = useState<string>(String(lastSpaceSeconds));
  const [pos, setPos] = useState<{ x: number; y: number }>({ x, y });
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Close on outside-click or Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    inputRef.current?.select();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Clamp the menu inside the viewport once it's measured. Runs before
  // paint so the user doesn't see an off-screen flash.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    let nx = x;
    let ny = y;
    if (nx + r.width > window.innerWidth - margin) {
      nx = Math.max(margin, window.innerWidth - r.width - margin);
    }
    if (ny + r.height > window.innerHeight - margin) {
      ny = Math.max(margin, window.innerHeight - r.height - margin);
    }
    if (nx !== pos.x || ny !== pos.y) setPos({ x: nx, y: ny });
  }, [x, y, pos.x, pos.y]);

  const idx = timeline.findIndex((c) => c.id === clipId);
  if (idx === -1) return null;

  const parsed = Number(seconds);
  const valid = Number.isFinite(parsed) && parsed > 0;

  const insert = (where: "before" | "after") => {
    if (!valid) return;
    setLastSpaceSeconds(parsed);
    addBlank(parsed, where === "before" ? idx : idx + 1);
    onClose();
  };

  return (
    <div
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 w-56 rounded-md border border-border bg-bg-panel shadow-xl text-sm overflow-hidden"
    >
      <div className="p-2 border-b border-border space-y-1.5">
        <label className="block text-[10px] uppercase tracking-wider text-text-muted">
          Seconds of blank space
        </label>
        <input
          ref={inputRef}
          type="number"
          step="0.5"
          min="0.1"
          value={seconds}
          onChange={(e) => setSeconds(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") insert("after");
          }}
          className="w-full h-7 rounded border border-border bg-bg px-2 text-sm focus:outline-none focus:border-accent"
        />
      </div>
      <button
        disabled={!valid}
        onClick={() => insert("before")}
        className="w-full px-3 py-2 text-left hover:bg-bg-elevated disabled:opacity-40 disabled:cursor-not-allowed"
      >
        ⬅ Add space before
      </button>
      <button
        disabled={!valid}
        onClick={() => insert("after")}
        className="w-full px-3 py-2 text-left hover:bg-bg-elevated border-t border-border disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Add space after ➡
      </button>
      <button
        onClick={() => {
          removeClip(clipId);
          onClose();
        }}
        className="w-full px-3 py-2 text-left hover:bg-rose-500/20 text-rose-400 border-t border-border"
      >
        ✕ Delete clip
      </button>
    </div>
  );
}

function Ruler({
  pxPerSecond,
  total,
  playheadX,
  onSeek,
}: {
  pxPerSecond: number;
  total: number;
  playheadX: number;
  onSeek: (timeSec: number) => void;
}) {
  const tickInterval = pickTickInterval(pxPerSecond);
  // Render ticks across the whole padded range, including the left/right
  // overscroll, so scrubbing into the padding still shows time.
  const startSec = -TIMELINE_PADDING_PX / pxPerSecond;
  const endSec = (TIMELINE_PADDING_PX + total * pxPerSecond + TIMELINE_PADDING_PX) /
    pxPerSecond;
  const firstTick = Math.ceil(startSec / tickInterval) * tickInterval;
  const ticks: number[] = [];
  for (let t = firstTick; t <= endSec; t += tickInterval) {
    ticks.push(Number(t.toFixed(4)));
  }

  return (
    <div
      className="absolute left-0 right-0 top-0 border-b border-border bg-bg cursor-crosshair select-none"
      style={{ height: RULER_HEIGHT }}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const time = (x - TIMELINE_PADDING_PX) / pxPerSecond;
        onSeek(time);
      }}
      title="Click to set playhead"
    >
      {ticks.map((t) => {
        const x = TIMELINE_PADDING_PX + t * pxPerSecond;
        if (x < 0 || t < 0 || t > total + 0.001) {
          // Tick falls in the padding region — render a faint mark only.
          return (
            <div
              key={t}
              className="absolute top-0 bottom-0 w-px bg-border/50 pointer-events-none"
              style={{ left: x }}
            />
          );
        }
        return (
          <div
            key={t}
            className="absolute top-0 bottom-0 pointer-events-none flex items-end"
            style={{ left: x }}
          >
            <div className="w-px h-2 bg-text-muted/60" />
            <span className="absolute bottom-0 left-1 text-[10px] font-mono text-text-muted leading-none pb-0.5">
              {fmtRulerTime(t)}
            </span>
          </div>
        );
      })}
      {/* A small playhead-tip indicator on the ruler itself. */}
      <div
        className="absolute top-0 w-0 h-0 pointer-events-none z-20"
        style={{
          left: playheadX,
          borderLeft: "5px solid transparent",
          borderRight: "5px solid transparent",
          borderTop: "6px solid #3B82F6",
          transform: "translateX(-5px)",
        }}
      />
    </div>
  );
}

/** Ruler labels show hours when needed, fractional seconds at very high zoom. */
function fmtRulerTime(s: number): string {
  if (s < 0) return "";
  const sign = s < 0 ? "-" : "";
  const abs = Math.abs(s);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const sec = abs % 60;
  if (h > 0) {
    return `${sign}${h}:${String(m).padStart(2, "0")}:${String(Math.floor(sec)).padStart(2, "0")}`;
  }
  if (Number.isInteger(sec)) {
    return `${sign}${m}:${String(Math.floor(sec)).padStart(2, "0")}`;
  }
  return `${sign}${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

function ClipBlock({
  clip,
  index,
  pxPerSecond,
  highlight,
  onContextMenu,
}: {
  clip: SpliceClip;
  index: number;
  pxPerSecond: number;
  highlight: boolean;
  onContextMenu: (e: React.MouseEvent, clipId: string) => void;
}) {
  const removeClip = useSplicing((s) => s.removeClip);
  const selectClip = useSplicing((s) => s.selectClip);
  const isSelected = useSplicing((s) => s.selectedIds.includes(clip.id));
  const dur = clipDuration(clip);
  const width = Math.max(40, dur * pxPerSecond);

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(
      DRAG_MIME,
      JSON.stringify({ kind: "clip", id: clip.id }),
    );
  };

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectClip(clip.id, e.metaKey || e.ctrlKey);
  };

  const title =
    clip.kind === "video"
      ? `Clip ${index + 1} · ${clip.sourcePath.split("/").pop()} (${fmtDuration(dur)})`
      : `Blank · ${fmtDuration(dur)}`;

  return (
    <>
      {highlight && <div className="w-1 bg-accent shrink-0" />}
      <div
        data-clip-index={index}
        draggable
        onDragStart={onDragStart}
        onClick={onClick}
        onContextMenu={(e) => onContextMenu(e, clip.id)}
        className={
          "group relative shrink-0 h-full border-r overflow-hidden cursor-grab active:cursor-grabbing " +
          (isSelected
            ? "border-accent ring-2 ring-accent z-[5] bg-accent/10"
            : "border-border bg-bg-elevated")
        }
        style={{ width }}
        title={title}
      >
        {clip.kind === "video" ? (
          <VideoClipContent clip={clip} width={width} />
        ) : (
          <div className="absolute inset-0 bg-black" />
        )}
        <div className="absolute inset-x-0 top-0 h-5 bg-black/60 backdrop-blur-sm text-[10px] text-text-secondary px-1.5 flex items-center justify-between pointer-events-none">
          <span className="truncate">
            {index + 1}.{" "}
            {clip.kind === "video"
              ? clip.sourcePath.split("/").pop()
              : "blank"}
          </span>
          <span className="font-mono text-text-muted shrink-0 ml-1">
            {fmtDuration(dur)}
          </span>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            removeClip(clip.id);
          }}
          className="absolute top-1 right-1 w-4 h-4 rounded bg-black/70 hover:bg-rose-500 text-[10px] text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
          title="Remove clip"
        >
          ✕
        </button>
      </div>
    </>
  );
}

function VideoClipContent({
  clip,
  width,
}: {
  clip: Extract<SpliceClip, { kind: "video" }>;
  width: number;
}) {
  const dur = clip.sourceEnd - clip.sourceStart;
  const thumbsQuery = useQuery({
    queryKey: ["thumbnails", clip.sourcePath],
    queryFn: () => api.getThumbnails(clip.sourcePath, 60, 60),
    staleTime: Infinity,
  });
  const peaksQuery = useQuery({
    queryKey: ["audio-peaks", clip.sourcePath],
    queryFn: () => api.getAudioPeaks(clip.sourcePath, 800),
    staleTime: Infinity,
  });
  const thumbsUrl = thumbsQuery.data ? `/api${thumbsQuery.data.url}` : null;
  const sourceScale = clip.sourceDuration / Math.max(dur, 0.001);
  const thumbsBgSize = `${sourceScale * 100}% 100%`;
  const thumbsBgPosX = `-${(clip.sourceStart / Math.max(dur, 0.001)) * 100}%`;
  const peaks = peaksQuery.data?.peaks;
  const peaksSlice = peaks
    ? peaks.slice(
        Math.floor((clip.sourceStart / clip.sourceDuration) * peaks.length),
        Math.ceil((clip.sourceEnd / clip.sourceDuration) * peaks.length),
      )
    : null;
  return (
    <>
      <div
        className="absolute inset-x-0 top-0 h-1/2 bg-black"
        style={{
          backgroundImage: thumbsUrl ? `url(${thumbsUrl})` : undefined,
          backgroundSize: thumbsBgSize,
          backgroundPosition: `${thumbsBgPosX} 0`,
          backgroundRepeat: "no-repeat",
        }}
      />
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-bg-panel">
        {peaksSlice && peaksSlice.length > 0 && (
          <Waveform peaks={peaksSlice} width={width} />
        )}
      </div>
    </>
  );
}

function Waveform({ peaks, width }: { peaks: number[]; width: number }) {
  const cols = Math.max(8, Math.floor(width));
  const step = peaks.length / cols;
  const VBH = 100;
  const path: string[] = [];
  for (let i = 0; i < cols; i++) {
    const v = peaks[Math.floor(i * step)] ?? 0;
    const h = Math.max(1, v * VBH);
    const y0 = (VBH - h) / 2;
    const y1 = y0 + h;
    path.push(`M${i} ${y0}V${y1}`);
  }
  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${cols} ${VBH}`}
      preserveAspectRatio="none"
      className="block"
    >
      <path d={path.join("")} stroke="#3B82F6" strokeWidth="1" />
    </svg>
  );
}
