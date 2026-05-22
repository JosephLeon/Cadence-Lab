import { useProject } from "../stores/project";
import { usePipeline } from "../hooks/usePipeline";
import type { JobState, PipelineState } from "../stores/project";

export function RightPanel() {
  const media = useProject((s) => s.media);
  const active = useProject((s) => s.activeMediaPath);
  const item = media.find((m) => m.path === active);
  const { runStage } = usePipeline(active);

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
              <StageRow
                label="Analyze speech"
                hint="Whisper + VAD via Groq"
                stage="analyze"
                done={!!item.pipeline.analysisPath}
                disabled={false}
                job={item.job}
                onRun={() => runStage("analyze")}
              />
              <StageRow
                label="Classify pauses & fillers"
                hint="Claude Opus 4.7"
                stage="classify"
                done={!!item.pipeline.classifiedPath}
                disabled={!item.pipeline.analysisPath}
                disabledReason="Run Analyze first"
                job={item.job}
                onRun={() => runStage("classify")}
              />
              <StageRow
                label="Build cut plan"
                hint="Interval algebra (instant)"
                stage="plan"
                done={!!item.pipeline.planPath}
                disabled={
                  !item.pipeline.analysisPath ||
                  !item.pipeline.classifiedPath
                }
                disabledReason="Classify first"
                job={item.job}
                onRun={() => runStage("plan")}
              />
              <StageRow
                label="Render MP4"
                hint="Hardware-accelerated"
                stage="render"
                done={!!item.pipeline.renderedPath}
                disabled={!item.pipeline.planPath}
                disabledReason="Build a plan first"
                job={item.job}
                onRun={() => runStage("render")}
              />
            </Section>

            <Section title="Output paths">
              <PipelinePaths pipeline={item.pipeline} />
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

interface StageRowProps {
  label: string;
  hint: string;
  stage: "analyze" | "classify" | "plan" | "render";
  done: boolean;
  disabled: boolean;
  disabledReason?: string;
  job: JobState | null;
  onRun: () => void;
}

function StageRow({
  label,
  hint,
  stage,
  done,
  disabled,
  disabledReason,
  job,
  onRun,
}: StageRowProps) {
  const isRunning = job?.stage === stage && !job.error;
  const showError = job?.stage === stage && !!job?.error;

  return (
    <div className="px-1 py-2">
      <div className="flex items-center gap-2">
        <span className="text-base shrink-0 w-4">
          {done ? "✓" : isRunning ? "●" : "○"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{label}</div>
          <div className="text-[10px] text-text-muted truncate">
            {disabled && disabledReason ? disabledReason : hint}
          </div>
        </div>
        <button
          disabled={disabled || isRunning}
          onClick={onRun}
          className="shrink-0 px-2 py-1 text-xs rounded-md bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-bg-elevated text-white font-medium transition-colors"
        >
          {isRunning ? "Running…" : done ? "Re-run" : "Run"}
        </button>
      </div>

      {isRunning && (
        <div className="mt-2 ml-6">
          <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-200"
              style={{ width: `${Math.max(2, job.progress * 100)}%` }}
            />
          </div>
          <div className="mt-1 text-[10px] text-text-secondary truncate">
            {job.message || "…"}
          </div>
        </div>
      )}

      {showError && (
        <div className="mt-2 ml-6 text-[10px] text-rose-400" title={job?.error}>
          ✗ {job?.error}
        </div>
      )}
    </div>
  );
}

function PipelinePaths({ pipeline }: { pipeline: PipelineState }) {
  const rows = [
    ["Analysis", pipeline.analysisPath],
    ["Classification", pipeline.classifiedPath],
    ["Plan", pipeline.planPath],
    ["Rendered", pipeline.renderedPath],
  ] as const;

  if (rows.every(([, p]) => !p)) {
    return (
      <div className="text-[10px] text-text-muted px-1">
        Run the pipeline to populate output paths.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {rows.map(([label, path]) => (
        <div key={label} className="px-1 py-0.5">
          <div className="text-[10px] text-text-muted">{label}</div>
          <div
            className="text-xs font-mono truncate"
            title={path ?? "(not produced yet)"}
          >
            {path ?? <span className="text-text-muted">—</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
