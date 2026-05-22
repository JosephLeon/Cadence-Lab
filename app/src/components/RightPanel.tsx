import { useProject } from "../stores/project";

export function RightPanel() {
  const media = useProject((s) => s.media);
  const active = useProject((s) => s.activeMediaPath);
  const item = media.find((m) => m.path === active);

  return (
    <aside className="w-80 shrink-0 border-l border-border bg-bg-panel flex flex-col">
      <div className="h-10 shrink-0 border-b border-border flex items-center px-3">
        <h2 className="text-sm font-medium text-text-secondary uppercase tracking-wider">
          AI Controls
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {!item ? (
          <div className="text-sm text-text-muted">
            Select a clip to see AI options.
          </div>
        ) : (
          <>
            <Section title="Inspector">
              <KV label="File" value={item.path.split("/").pop() ?? "—"} />
              {item.probe && (
                <>
                  <KV
                    label="Duration"
                    value={`${item.probe.duration_seconds.toFixed(2)} s`}
                  />
                  <KV
                    label="Resolution"
                    value={
                      item.probe.width
                        ? `${item.probe.width}×${item.probe.height}`
                        : "—"
                    }
                  />
                  <KV
                    label="Frame rate"
                    value={
                      item.probe.frame_rate
                        ? `${item.probe.frame_rate.toFixed(2)} fps`
                        : "—"
                    }
                  />
                  <KV
                    label="Audio tracks"
                    value={item.probe.audio_tracks.length}
                  />
                </>
              )}
            </Section>

            <Section title="Pipeline">
              {/* Placeholders — wired up in upcoming phases */}
              <StageButton label="Analyze speech" hint="Whisper + VAD via Groq" disabled />
              <StageButton label="Classify pauses & fillers" hint="Claude Opus 4.7" disabled />
              <StageButton label="Build cut plan" hint="Interval algebra" disabled />
              <StageButton label="Render MP4" hint="Hardware-accelerated" disabled />
            </Section>

            <Section title="Layers">
              <div className="text-xs text-text-muted px-1">
                AI modifications appear here as non-destructive layers.
              </div>
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-[10px] font-medium tracking-widest uppercase text-text-muted mb-2 px-1">
        {title}
      </h3>
      <div className="rounded-md border border-border bg-bg p-2 space-y-1">
        {children}
      </div>
    </section>
  );
}

function KV({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between px-1 py-0.5 text-xs">
      <span className="text-text-secondary">{label}</span>
      <span className="text-text-primary font-medium">{value}</span>
    </div>
  );
}

function StageButton({
  label,
  hint,
  disabled,
}: {
  label: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      className="w-full text-left px-2 py-2 rounded-md hover:bg-bg-elevated disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      <div className="text-sm font-medium">{label}</div>
      <div className="text-[10px] text-text-muted">{hint}</div>
    </button>
  );
}
