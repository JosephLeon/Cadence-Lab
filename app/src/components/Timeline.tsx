import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useProject } from "../stores/project";
import { videoRef } from "../stores/videoRef";
import { planCache } from "../stores/planCache";
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

export function Timeline() {
  const media = useProject((s) => s.media);
  const active = useProject((s) => s.activeMediaPath);
  const playback = useProject((s) => s.playback);
  const item = media.find((m) => m.path === active);
  const planPath = item?.pipeline.planPath;

  const duration = playback.duration || item?.probe?.duration_seconds || 0;

  const planQuery = useQuery({
    queryKey: ["plan-bundle", planPath],
    queryFn: () => api.getPlan(planPath!),
    enabled: !!planPath,
  });

  // Push keep-segment boundaries to the module-level cache so the keyboard
  // shortcut hook can do "jump to next/prev cut" without prop-drilling.
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

  return (
    <div className="h-44 shrink-0 border-t border-border bg-bg-panel flex flex-col">
      <div className="h-8 shrink-0 border-b border-border flex items-center px-3 gap-3">
        <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wider">
          Timeline
        </h2>
        <div className="flex-1" />
        <span className="text-[10px] text-text-muted font-mono">
          {fmtTime(playback.currentTime)} / {fmtTime(duration)}
        </span>
        {planQuery.data && (
          <span className="text-[10px] text-text-secondary">
            {planQuery.data.keeps.length} keeps, {cuts.length} cuts
          </span>
        )}
      </div>

      <div className="flex-1 grid grid-rows-3 gap-1 p-2">
        <TrackBase
          name="Video"
          duration={duration}
          currentTime={playback.currentTime}
        />
        <TrackBase
          name="Audio"
          duration={duration}
          currentTime={playback.currentTime}
        />
        <CutsTrack
          name="AI cuts"
          duration={duration}
          currentTime={playback.currentTime}
          keeps={planQuery.data?.keeps ?? []}
          cuts={cuts}
        />
      </div>
    </div>
  );
}

interface TrackProps {
  name: string;
  duration: number;
  currentTime: number;
  children?: React.ReactNode;
}

function TrackBase({ name, duration, currentTime, children }: TrackProps) {
  const cursorPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const trackRef = useRef<HTMLDivElement | null>(null);

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0 || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    videoRef.seek(frac * duration);
  };

  return (
    <div className="flex items-center bg-bg rounded-md border border-border-subtle overflow-hidden">
      <div className="w-20 shrink-0 text-[10px] uppercase tracking-wider text-text-muted px-2 border-r border-border-subtle">
        {name}
      </div>
      <div
        ref={trackRef}
        onClick={seek}
        className="relative flex-1 h-full cursor-pointer select-none"
      >
        {children}
        {duration > 0 && (
          <div
            className="absolute top-0 bottom-0 w-px bg-accent pointer-events-none z-10"
            style={{ left: `${cursorPct}%` }}
          >
            <div className="absolute -top-px -left-1 w-2 h-2 rotate-45 bg-accent" />
          </div>
        )}
      </div>
    </div>
  );
}

interface CutsTrackProps extends TrackProps {
  keeps: { source_start: number; source_end: number }[];
  cuts: CutMarker[];
}

function CutsTrack({
  name,
  duration,
  currentTime,
  keeps,
  cuts,
}: CutsTrackProps) {
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
      const width = Math.max(((c.end - c.start) / duration) * 100, 0.1);
      const dur_ms = Math.round((c.end - c.start) * 1000);
      const label = `${c.kind.replace("_", " ")} · ${dur_ms}ms`;
      return { key: i, left, width, start: c.start, label, reason: c.reason };
    });
  }, [cuts, duration]);

  return (
    <TrackBase name={name} duration={duration} currentTime={currentTime}>
      <div className="absolute inset-0 bg-rose-500/10" />
      {keepSegments.map((s) => (
        <div
          key={s.key}
          className="absolute top-0 bottom-0 bg-emerald-500/25 border-l border-r border-emerald-500/40"
          style={{ left: `${s.left}%`, width: `${s.width}%` }}
        />
      ))}
      {/* Cut markers with hover tooltips. Stop click propagation so clicking
          a marker still seeks rather than just triggering the track-level
          handler at a slightly different x. */}
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
          {/* Hit area / hover highlight */}
          <div className="absolute inset-0 hover:bg-rose-400/30 transition-colors" />
          <div className="absolute inset-y-0 left-0 w-px bg-rose-400/60" />
          <div className="absolute inset-y-0 right-0 w-px bg-rose-400/60" />
          {/* Tooltip — appears above the timeline on hover */}
          <div
            className="
              absolute bottom-full left-1/2 -translate-x-1/2 mb-1
              hidden group-hover:block
              whitespace-nowrap bg-bg-elevated border border-border
              text-text-primary text-[10px] px-2 py-1 rounded-md shadow-lg
              z-20 pointer-events-none
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
    </TrackBase>
  );
}
