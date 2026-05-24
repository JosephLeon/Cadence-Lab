import { useCallback, useEffect, useRef, useState } from "react";
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
        const v = spliceVideoRef.current;
        if (!v) return;
        if (v.paused) v.play().catch(() => {});
        else v.pause();
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

  const at = clipAtPlayhead(timeline, playhead);
  const total = totalDuration(timeline);

  const currentSrc = at ? api.sourceUrl(at.clip.sourcePath) : null;
  const lastSrcRef = useRef<string | null>(null);

  // Seek + swap source as the playhead moves. The video's currentTime is
  // (clip.sourceStart + offset-within-clip) because a single clip may only
  // play a sub-range of its underlying source after splits.
  useEffect(() => {
    const el = spliceVideoRef.current;
    if (!el || !at) return;
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

  // Auto-advance: when playback runs past the current clip's sourceEnd,
  // jump the global playhead to the next clip's start so the source swap
  // happens via the effect above. The last clip just stops at total.
  const onTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!at) return;
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
        {at ? (
          <video
            ref={(el) => {
              spliceVideoRef.current = el;
            }}
            src={currentSrc ?? undefined}
            controls
            className="max-w-full max-h-full rounded-md shadow-lg bg-black"
            onTimeUpdate={onTimeUpdate}
          />
        ) : (
          <div className="text-text-muted text-sm text-center">
            Drag clips from the left panel onto the timeline below.
            <div className="mt-2 text-xs">
              Space: play/pause · B: split · ⌫: delete selected · Cmd+wheel: zoom
            </div>
          </div>
        )}
      </div>
      <div className="h-8 shrink-0 border-t border-border flex items-center px-4 text-xs text-text-secondary gap-3">
        <span className="font-mono">
          {fmtDuration(playhead)} / {fmtDuration(total)}
        </span>
        {at && (
          <span className="truncate text-text-muted">
            clip {at.index + 1} of {timeline.length} ·{" "}
            {at.clip.sourcePath.split("/").pop()}
          </span>
        )}
      </div>
    </main>
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
  const stripRef = useRef<HTMLDivElement | null>(null);

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
}: {
  clip: SpliceClip;
  index: number;
  pxPerSecond: number;
  highlight: boolean;
}) {
  const removeClip = useSplicing((s) => s.removeClip);
  const selectClip = useSplicing((s) => s.selectClip);
  const isSelected = useSplicing((s) => s.selectedIds.includes(clip.id));
  const dur = clipDuration(clip);
  const width = Math.max(40, dur * pxPerSecond);

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

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(
      DRAG_MIME,
      JSON.stringify({ kind: "clip", id: clip.id }),
    );
  };

  const onClick = (e: React.MouseEvent) => {
    // Click selects (use the ruler to set the playhead). Cmd/Ctrl-click
    // toggles in the current selection for multi-select.
    e.stopPropagation();
    selectClip(clip.id, e.metaKey || e.ctrlKey);
  };

  const thumbsUrl = thumbsQuery.data ? `/api${thumbsQuery.data.url}` : null;

  // The thumbnail sprite spans the *full* source. For a clip showing only
  // sourceStart..sourceEnd, we scale the sprite so the full source covers
  // (sourceDuration / clipDuration) × the block width, then shift left so
  // sourceStart lines up with the block's left edge.
  const sourceScale = clip.sourceDuration / Math.max(dur, 0.001);
  const thumbsBgSize = `${sourceScale * 100}% 100%`;
  const thumbsBgPosX = `-${(clip.sourceStart / Math.max(dur, 0.001)) * 100}%`;

  // Peaks span the full source — slice to the clip's range for the waveform.
  const peaks = peaksQuery.data?.peaks;
  const peaksSlice = peaks
    ? peaks.slice(
        Math.floor((clip.sourceStart / clip.sourceDuration) * peaks.length),
        Math.ceil((clip.sourceEnd / clip.sourceDuration) * peaks.length),
      )
    : null;

  return (
    <>
      {highlight && <div className="w-1 bg-accent shrink-0" />}
      <div
        data-clip-index={index}
        draggable
        onDragStart={onDragStart}
        onClick={onClick}
        className={
          "group relative shrink-0 h-full border-r overflow-hidden cursor-grab active:cursor-grabbing " +
          (isSelected
            ? "border-accent ring-2 ring-accent z-[5] bg-accent/10"
            : "border-border bg-bg-elevated")
        }
        style={{ width }}
        title={`Clip ${index + 1} · ${clip.sourcePath.split("/").pop()} (${fmtDuration(dur)})`}
      >
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
        <div className="absolute inset-x-0 top-0 h-5 bg-black/60 backdrop-blur-sm text-[10px] text-text-secondary px-1.5 flex items-center justify-between pointer-events-none">
          <span className="truncate">
            {index + 1}. {clip.sourcePath.split("/").pop()}
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
