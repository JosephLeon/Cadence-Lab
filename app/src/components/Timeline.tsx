import { useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useProject } from "../stores/project";
import { videoRef } from "../stores/videoRef";
import { api } from "../api/client";

function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function Timeline() {
  const media = useProject((s) => s.media);
  const active = useProject((s) => s.activeMediaPath);
  const playback = useProject((s) => s.playback);
  const item = media.find((m) => m.path === active);
  const planPath = item?.pipeline.planPath;

  // Source duration drives the timeline scale. Prefer the live <video>
  // duration (most accurate) but fall back to the probe value while metadata
  // is still loading.
  const duration = playback.duration || item?.probe?.duration_seconds || 0;

  // Pull the cut plan if we have one — drives the green/red overlay.
  const planQuery = useQuery({
    queryKey: ["plan-bundle", planPath],
    queryFn: () => api.getPlan(planPath!),
    enabled: !!planPath,
  });

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
            {planQuery.data.keeps.length} keeps,{" "}
            {planQuery.data.cuts.length} cuts
          </span>
        )}
      </div>

      <div className="flex-1 grid grid-rows-3 gap-1 p-2">
        {/* Video track — playhead lives on this row */}
        <TrackBase
          name="Video"
          duration={duration}
          currentTime={playback.currentTime}
        />

        {/* Audio track */}
        <TrackBase
          name="Audio"
          duration={duration}
          currentTime={playback.currentTime}
        />

        {/* AI cuts track — keep / cut overlay from the plan */}
        <CutsTrack
          name="AI cuts"
          duration={duration}
          currentTime={playback.currentTime}
          keeps={planQuery.data?.keeps ?? []}
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
}

function CutsTrack({ name, duration, currentTime, keeps }: CutsTrackProps) {
  // Precompute segment styles so we don't recompute on every cursor tick.
  const segments = useMemo(() => {
    if (duration <= 0) return [];
    return keeps.map((k, i) => {
      const left = (k.source_start / duration) * 100;
      const width = ((k.source_end - k.source_start) / duration) * 100;
      return { key: i, left, width };
    });
  }, [keeps, duration]);

  return (
    <TrackBase name={name} duration={duration} currentTime={currentTime}>
      {/* Cuts background — everything red */}
      <div className="absolute inset-0 bg-rose-500/15" />
      {/* Keep segments — green on top */}
      {segments.map((s) => (
        <div
          key={s.key}
          className="absolute top-0 bottom-0 bg-emerald-500/30 border-l border-r border-emerald-500/40"
          style={{ left: `${s.left}%`, width: `${s.width}%` }}
        />
      ))}
    </TrackBase>
  );
}
