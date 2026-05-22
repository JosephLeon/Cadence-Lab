export function Timeline() {
  return (
    <div className="h-44 shrink-0 border-t border-border bg-bg-panel flex flex-col">
      <div className="h-8 shrink-0 border-b border-border flex items-center px-3 gap-3">
        <h2 className="text-xs font-medium text-text-secondary uppercase tracking-wider">
          Timeline
        </h2>
        <div className="flex-1" />
        <div className="text-[10px] text-text-muted">
          Multi-track scrubbing wires up in Phase 3
        </div>
      </div>
      <div className="flex-1 grid grid-rows-3 gap-0.5 p-2">
        <TimelineTrack name="Video" />
        <TimelineTrack name="Audio" />
        <TimelineTrack name="AI cuts" />
      </div>
    </div>
  );
}

function TimelineTrack({ name }: { name: string }) {
  return (
    <div className="flex items-center bg-bg rounded-md border border-border-subtle overflow-hidden">
      <div className="w-20 shrink-0 text-[10px] uppercase tracking-wider text-text-muted px-2 border-r border-border-subtle">
        {name}
      </div>
      <div className="flex-1 h-full bg-gradient-to-r from-bg-elevated/20 to-transparent" />
    </div>
  );
}
