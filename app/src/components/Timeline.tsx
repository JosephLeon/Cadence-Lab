import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useProject } from "../stores/project";
import { videoRef } from "../stores/videoRef";
import { planCache } from "../stores/planCache";
import { useTimelineView } from "../hooks/useTimelineView";
import { api } from "../api/client";

function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

interface CutMarker {
  start: number;
  end: number;
  kind: string;
  reason: string;
}

const ZOOM_STEP = 1.25;

export function Timeline() {
  const media = useProject((s) => s.media);
  const active = useProject((s) => s.activeMediaPath);
  const playback = useProject((s) => s.playback);
  const item = media.find((m) => m.path === active);
  const planPath = item?.pipeline.planPath;

  const duration = playback.duration || item?.probe?.duration_seconds || 0;

  const { height, zoom, setHeight, setZoom, fit } = useTimelineView();

  // Refs for the geometry math the scroll/zoom handlers need.
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const planQuery = useQuery({
    queryKey: ["plan-bundle", planPath],
    queryFn: () => api.getPlan(planPath!),
    enabled: !!planPath,
  });

  const thumbsQuery = useQuery({
    queryKey: ["thumbnails", item?.path],
    queryFn: () => api.getThumbnails(item!.path, 60, 60),
    enabled: !!item?.path,
    staleTime: Infinity,
  });

  const peaksQuery = useQuery({
    queryKey: ["audio-peaks", item?.path],
    queryFn: () => api.getAudioPeaks(item!.path, 2000),
    enabled: !!item?.path,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!planQuery.data) {
      planCache.set([]);
      return;
    }
    const xs: number[] = [];
    for (const k of planQuery.data.keeps) {
      xs.push(k.source_start);
      xs.push(k.source_end);
    }
    planCache.set(xs);
  }, [planQuery.data]);

  const cuts: CutMarker[] = useMemo(() => {
    if (!planQuery.data) return [];
    return planQuery.data.cuts.map((c) => ({
      start: c.source_start,
      end: c.source_end,
      kind: c.kind,
      reason: c.reason,
    }));
  }, [planQuery.data]);

  // ─── Cmd+wheel: mouse-centered zoom ───────────────────────────────────
  //
  // Bind via addEventListener with {passive: false} so we can preventDefault
  // — React's onWheel is sometimes passive depending on version + element.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseXInViewport = e.clientX - rect.left;
      const contentXBefore = mouseXInViewport + el.scrollLeft;

      // Negative deltaY = wheel up = zoom in (matches macOS pinch convention)
      const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
      setZoom((prev) => {
        const next = Math.max(1, Math.min(50, prev * factor));
        // Adjust scrollLeft after the zoom so the same content point stays
        // under the cursor. Defer one frame so the new width has applied.
        requestAnimationFrame(() => {
          const ratio = next / prev;
          const newContentX = contentXBefore * ratio;
          el.scrollLeft = newContentX - mouseXInViewport;
        });
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setZoom]);

  // ─── Top-edge drag-resize ────────────────────────────────────────────
  //
  // Pointer-down on the handle starts a drag; window-level pointermove
  // tracks until pointerup. Window listeners (not handle-local) so the
  // drag continues even if the cursor briefly leaves the handle.
  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = height;
      const onMove = (ev: PointerEvent) => {
        // Dragging UP makes timeline TALLER (height grows as cursor moves up)
        setHeight(startH + (startY - ev.clientY));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [height, setHeight],
  );

  // ─── Keyboard shortcuts (Cmd+0, Cmd+=, Cmd+-) ─────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "0") {
        e.preventDefault();
        fit();
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoom((z) => z * ZOOM_STEP);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setZoom((z) => z / ZOOM_STEP);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setZoom, fit]);

  // ─── Click-to-seek (zoom + scroll aware) ─────────────────────────────
  const seekFromClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (duration <= 0 || !scrollRef.current) return;
      const el = scrollRef.current;
      const rect = el.getBoundingClientRect();
      const mouseXInViewport = e.clientX - rect.left;
      const contentX = mouseXInViewport + el.scrollLeft;
      const contentWidth = rect.width * zoom;
      const frac = Math.max(0, Math.min(1, contentX / contentWidth));
      videoRef.seek(frac * duration);
    },
    [duration, zoom],
  );

  return (
    <div
      className="shrink-0 border-t border-border bg-bg-panel flex flex-col relative"
      style={{ height }}
    >
      {/* Drag handle on the top edge — invisible until hover */}
      <div
        onPointerDown={startResize}
        className="
          absolute -top-1 left-0 right-0 h-2 z-30 group
          cursor-row-resize
        "
        title="Drag to resize"
      >
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-1 rounded-full bg-text-muted/0 group-hover:bg-accent/60 transition-colors" />
      </div>

      {/* Header */}
      <div className="h-8 shrink-0 border-b border-border flex items-center px-3 gap-3">
        <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wider">
          Timeline
        </h2>
        <div className="flex-1" />

        {/* Zoom controls */}
        <div className="flex items-center gap-1 text-[10px]">
          <button
            onClick={() => setZoom((z) => z / ZOOM_STEP)}
            disabled={zoom <= 1}
            className="h-5 w-5 rounded text-text-muted hover:text-text-primary hover:bg-bg-elevated disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Zoom out (⌘−)"
          >
            −
          </button>
          <button
            onClick={fit}
            className="h-5 px-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors font-mono min-w-[3rem]"
            title="Fit to width (⌘0)"
          >
            {zoom < 1.05 ? "Fit" : `${zoom.toFixed(1)}×`}
          </button>
          <button
            onClick={() => setZoom((z) => z * ZOOM_STEP)}
            disabled={zoom >= 50}
            className="h-5 w-5 rounded text-text-muted hover:text-text-primary hover:bg-bg-elevated disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Zoom in (⌘=)"
          >
            +
          </button>
        </div>

        <div className="h-3 w-px bg-border" />

        <span className="text-[10px] text-text-muted font-mono">
          {fmtTime(playback.currentTime)} / {fmtTime(duration)}
        </span>
        {planQuery.data && (
          <span className="text-[10px] text-text-secondary">
            {planQuery.data.keeps.length} keeps, {cuts.length} cuts
          </span>
        )}
      </div>

      {/* Tracks: labels on the left, scrollable area on the right */}
      <div className="flex-1 flex min-h-0">
        {/* Sticky labels column */}
        <div className="w-20 shrink-0 border-r border-border-subtle flex flex-col">
          {(["Video", "Audio", "AI cuts"] as const).map((label) => (
            <div
              key={label}
              className="flex-1 flex items-center px-2 text-[10px] uppercase tracking-wider text-text-muted border-b border-border-subtle last:border-b-0"
            >
              {label}
            </div>
          ))}
        </div>

        {/* Scrollable + zoomable track content */}
        <div
          ref={scrollRef}
          onClick={seekFromClick}
          className="flex-1 overflow-x-auto overflow-y-hidden cursor-pointer select-none"
          style={{ overscrollBehaviorX: "contain" }}
        >
          <div
            className="relative h-full"
            style={{ width: `${zoom * 100}%`, minWidth: "100%" }}
          >
            {/* Video track */}
            <Track
              top="0%"
              bottom="66.67%"
              duration={duration}
              currentTime={playback.currentTime}
            >
              {thumbsQuery.data ? (
                <div
                  className="absolute inset-0"
                  style={{
                    backgroundImage: `url("/api${thumbsQuery.data.url}")`,
                    backgroundSize: "100% 100%",
                    backgroundRepeat: "no-repeat",
                    opacity: 0.95,
                  }}
                />
              ) : thumbsQuery.isLoading ? (
                <div className="absolute inset-0 flex items-center justify-center text-[10px] text-text-muted bg-bg-elevated/30 animate-pulse">
                  Generating thumbnails…
                </div>
              ) : null}
            </Track>

            {/* Audio track */}
            <Track
              top="33.33%"
              bottom="33.33%"
              duration={duration}
              currentTime={playback.currentTime}
            >
              {peaksQuery.data ? (
                <Waveform
                  peaks={peaksQuery.data.peaks}
                  currentTime={playback.currentTime}
                  duration={duration}
                />
              ) : peaksQuery.isLoading ? (
                <div className="absolute inset-0 flex items-center justify-center text-[10px] text-text-muted bg-bg-elevated/30 animate-pulse">
                  Computing waveform…
                </div>
              ) : null}
            </Track>

            {/* AI cuts track */}
            <Track
              top="66.67%"
              bottom="0%"
              duration={duration}
              currentTime={playback.currentTime}
            >
              <CutsOverlay
                duration={duration}
                keeps={planQuery.data?.keeps ?? []}
                cuts={cuts}
              />
            </Track>

            {/* Playhead — spans all 3 tracks */}
            {duration > 0 && (
              <div
                className="absolute top-0 bottom-0 w-px bg-accent pointer-events-none z-20"
                style={{
                  left: `${(playback.currentTime / duration) * 100}%`,
                }}
              >
                <div className="absolute -top-px -left-1 w-2 h-2 rotate-45 bg-accent" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface TrackProps {
  top: string;
  bottom: string;
  duration: number;
  currentTime: number;
  children?: React.ReactNode;
}

function Track({ top, bottom, children }: TrackProps) {
  return (
    <div
      className="absolute left-0 right-0 bg-bg border border-border-subtle overflow-hidden"
      style={{ top, bottom, margin: "2px 0" }}
    >
      {children}
    </div>
  );
}

interface WaveformProps {
  peaks: number[];
  currentTime: number;
  duration: number;
}

function Waveform({ peaks, currentTime, duration }: WaveformProps) {
  const playedPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bars = useMemo(() => {
    const h = 100;
    const centerY = h / 2;
    return peaks.map((p, i) => {
      const height = Math.max(p * h, 1);
      return (
        <rect
          key={i}
          x={i}
          y={centerY - height / 2}
          width={1}
          height={height}
        />
      );
    });
  }, [peaks]);

  return (
    <svg
      viewBox={`0 0 ${peaks.length} 100`}
      preserveAspectRatio="none"
      className="absolute inset-0 w-full h-full"
    >
      <defs>
        <clipPath id="played-clip">
          <rect x="0" y="0" width={(playedPct / 100) * peaks.length} height="100" />
        </clipPath>
      </defs>
      <g fill="#60A5FA" fillOpacity="0.45">{bars}</g>
      <g fill="#3B82F6" clipPath="url(#played-clip)">{bars}</g>
    </svg>
  );
}

interface CutsOverlayProps {
  duration: number;
  keeps: { source_start: number; source_end: number }[];
  cuts: CutMarker[];
}

function CutsOverlay({ duration, keeps, cuts }: CutsOverlayProps) {
  const keepSegments = useMemo(() => {
    if (duration <= 0) return [];
    return keeps.map((k, i) => {
      const left = (k.source_start / duration) * 100;
      const width = ((k.source_end - k.source_start) / duration) * 100;
      return { key: i, left, width };
    });
  }, [keeps, duration]);

  const cutMarkers = useMemo(() => {
    if (duration <= 0) return [];
    return cuts.map((c, i) => {
      const left = (c.start / duration) * 100;
      const width = Math.max(((c.end - c.start) / duration) * 100, 0.05);
      const dur_ms = Math.round((c.end - c.start) * 1000);
      const label = `${c.kind.replace("_", " ")} · ${dur_ms}ms`;
      return { key: i, left, width, start: c.start, label, reason: c.reason };
    });
  }, [cuts, duration]);

  return (
    <>
      <div className="absolute inset-0 bg-rose-500/10" />
      {keepSegments.map((s) => (
        <div
          key={s.key}
          className="absolute top-0 bottom-0 bg-emerald-500/25 border-l border-r border-emerald-500/40"
          style={{ left: `${s.left}%`, width: `${s.width}%` }}
        />
      ))}
      {cutMarkers.map((c) => (
        <div
          key={c.key}
          className="group absolute top-0 bottom-0 cursor-pointer"
          style={{ left: `${c.left}%`, width: `${c.width}%` }}
          onClick={(e) => {
            e.stopPropagation();
            videoRef.seek(c.start);
          }}
        >
          <div className="absolute inset-0 hover:bg-rose-400/30 transition-colors" />
          <div className="absolute inset-y-0 left-0 w-px bg-rose-400/60" />
          <div className="absolute inset-y-0 right-0 w-px bg-rose-400/60" />
          <div
            className="
              absolute bottom-full left-1/2 -translate-x-1/2 mb-1
              hidden group-hover:block
              whitespace-nowrap bg-bg-elevated border border-border
              text-text-primary text-[10px] px-2 py-1 rounded-md shadow-lg
              z-30 pointer-events-none
            "
          >
            <div className="font-mono">
              {fmtTime(c.start)} · {c.label}
            </div>
            <div className="text-text-secondary max-w-xs truncate">
              {c.reason}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
