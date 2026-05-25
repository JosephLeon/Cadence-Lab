import { useState } from "react";
import type {
  AudioSettings,
  JobState,
  MediaItem,
  PipelineState,
  SpeechEnhanceLevel,
} from "../stores/project";
import { useProject } from "../stores/project";
import { usePipeline } from "../hooks/usePipeline";
import { ProjectFilesPanel } from "./ProjectFilesPanel";

interface Props {
  onOpenReview: () => void;
}

type Tab = "pacing" | "audio";

export function RightPanel({ onOpenReview }: Props) {
  const media = useProject((s) => s.media);
  const active = useProject((s) => s.activeMediaPath);
  const setAudio = useProject((s) => s.setAudio);
  const item = media.find((m) => m.path === active);
  const { runStage } = usePipeline(active);

  const [tab, setTab] = useState<Tab>("pacing");

  if (!item) {
    return (
      <aside className="w-80 shrink-0 border-l border-border bg-bg-panel flex flex-col">
        <PanelHeader />
        <div className="flex-1 flex items-center justify-center text-sm text-text-muted">
          Select a clip to see AI options.
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-80 shrink-0 border-l border-border bg-bg-panel flex flex-col min-h-0">
      <PanelHeader />

      {/* Inspector — context that applies regardless of tab. Collapsible
          and starts closed to save vertical space; the data here is rarely
          needed once the user knows what clip they loaded. */}
      <div className="shrink-0 border-b border-border">
        <Inspector item={item} />
      </div>

      {/* Pipeline — feeds both Pacing and Audio. Lives above the tabs so
          it's clear these stages are prerequisites for either flow. */}
      <div className="shrink-0 border-b border-border">
        <PipelineSection item={item} onRun={runStage} />
      </div>

      {/* Project Files — browse sources and accumulated renders for the
          active project. Collapsible, starts closed. */}
      <div className="shrink-0 border-b border-border">
        <ProjectFilesPanel />
      </div>

      {/* Tabs */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <Tabs tab={tab} onChange={setTab} />
      </div>

      {/* Tab content (scrolls). Each tab owns its own render action so
          the two stay independent: audio enhancement no longer pulls in
          the AI cuts just because a plan happens to exist. */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4 min-h-0">
        {tab === "pacing" ? (
          <PacingTab
            item={item}
            onOpenReview={onOpenReview}
            onRender={() => runStage("render")}
          />
        ) : (
          <AudioTab
            item={item}
            onChange={(patch) => setAudio(item.path, patch)}
            onRender={() => runStage("render_audio")}
          />
        )}
      </div>
    </aside>
  );
}

function PipelineSection({
  item,
  onRun,
}: {
  item: MediaItem;
  onRun: (stage: "analyze" | "classify" | "plan" | "render") => void;
}) {
  const [open, setOpen] = useState(false);
  const stagesDone =
    (item.pipeline.analysisPath ? 1 : 0) +
    (item.pipeline.classifiedPath ? 1 : 0) +
    (item.pipeline.planPath ? 1 : 0);
  const isRunning =
    item.job &&
    (item.job.stage === "analyze" ||
      item.job.stage === "classify" ||
      item.job.stage === "plan") &&
    !item.job.error;

  return (
    <section>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-bg-elevated transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-text-muted text-xs w-3 shrink-0">
            {open ? "▾" : "▸"}
          </span>
          <h3 className="text-[10px] font-medium tracking-widest uppercase text-text-muted shrink-0">
            Pipeline
          </h3>
          {!open && (
            <span
              className={
                "text-xs truncate " +
                (stagesDone === 3
                  ? "text-emerald-400"
                  : isRunning
                  ? "text-accent"
                  : "text-text-secondary")
              }
            >
              {isRunning
                ? `${item.job?.stage}…`
                : stagesDone === 3
                ? "✓ ready to render"
                : `${stagesDone}/3 stages complete`}
            </span>
          )}
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3">
          <p className="text-[10px] text-text-secondary px-1 mb-2 leading-snug">
            Required before Pacing or Audio settings can be rendered. Walk
            through these three stages in order.
          </p>
          <div className="rounded-md border border-border bg-bg p-2 space-y-1">
            <StageRow
              label="Analyze speech"
              hint="Whisper + VAD via Groq"
              stage="analyze"
              done={!!item.pipeline.analysisPath}
              disabled={false}
              job={item.job}
              onRun={() => onRun("analyze")}
            />
            <StageRow
              label="Classify pauses & fillers"
              hint="Claude Opus 4.7"
              stage="classify"
              done={!!item.pipeline.classifiedPath}
              disabled={!item.pipeline.analysisPath}
              disabledReason="Run Analyze first"
              job={item.job}
              onRun={() => onRun("classify")}
            />
            <StageRow
              label="Build cut plan"
              hint="Interval algebra (instant)"
              stage="plan"
              done={!!item.pipeline.planPath}
              disabled={
                !item.pipeline.analysisPath || !item.pipeline.classifiedPath
              }
              disabledReason="Classify first"
              job={item.job}
              onRun={() => onRun("plan")}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function PanelHeader() {
  return (
    <div className="h-10 shrink-0 border-b border-border flex items-center px-3">
      <h2 className="text-sm font-medium text-text-secondary uppercase tracking-wider">
        AI Controls
      </h2>
    </div>
  );
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <div className="inline-flex w-full rounded-md border border-border bg-bg p-0.5">
      <TabButton selected={tab === "pacing"} onClick={() => onChange("pacing")}>
        Pacing
      </TabButton>
      <TabButton selected={tab === "audio"} onClick={() => onChange("audio")}>
        Audio
      </TabButton>
    </div>
  );
}

function TabButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex-1 px-3 py-1 text-xs font-medium rounded transition-colors " +
        (selected
          ? "bg-accent text-white"
          : "text-text-secondary hover:text-text-primary hover:bg-bg-elevated")
      }
    >
      {children}
    </button>
  );
}

// ─── Inspector (always visible) ──────────────────────────────────────────────

function Inspector({ item }: { item: MediaItem }) {
  const [open, setOpen] = useState(false);
  const fileName = item.path.split("/").pop() ?? "—";

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-bg-elevated transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-text-muted text-xs w-3 shrink-0">
            {open ? "▾" : "▸"}
          </span>
          <h3 className="text-[10px] font-medium tracking-widest uppercase text-text-muted shrink-0">
            Inspector
          </h3>
          {!open && (
            <span
              className="text-xs text-text-secondary truncate"
              title={fileName}
            >
              {fileName}
            </span>
          )}
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-1">
          <KV label="File" value={fileName} />
          {item.probe && (
            <>
              <KV
                label="Duration"
                value={`${item.probe.duration_seconds.toFixed(1)} s`}
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
        </div>
      )}
    </div>
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

// ─── Pacing tab ──────────────────────────────────────────────────────────────

interface PacingTabProps {
  item: MediaItem;
  onOpenReview: () => void;
  onRender: () => void;
}

function PacingTab({ item, onOpenReview, onRender }: PacingTabProps) {
  const isRendering =
    item.job?.stage === "render" && !item.job.error;
  const renderError =
    item.job?.stage === "render" && item.job.error ? item.job.error : null;
  const canRender = !!item.pipeline.planPath && !isRendering;
  const audioOn = item.audio.enhance_speech !== "off" || item.audio.auto_duck;

  return (
    <>
      <Section title="Review">
        <button
          onClick={onOpenReview}
          disabled={!item.pipeline.classifiedPath}
          className="w-full text-left px-2 py-2 rounded-md hover:bg-bg-elevated disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title={
            item.pipeline.classifiedPath
              ? "Review and override classifier decisions"
              : "Classify first to enable review"
          }
        >
          <div className="text-sm font-medium flex items-center gap-2">
            <span>🎚</span> Review &amp; refine cuts
          </div>
          <div className="text-[10px] text-text-muted">
            {item.pipeline.classifiedPath
              ? "Per-cut audio + override + re-plan"
              : "Classify first to enable"}
          </div>
        </button>
      </Section>

      <Section title="Render">
        <p className="text-[10px] text-text-muted px-1 mb-2 leading-snug">
          Applies the AI cut plan
          {audioOn
            ? " and bakes in the audio settings from the Audio tab."
            : "."}{" "}
          Produces a new MP4 in the project's renders folder.
        </p>
        {isRendering ? (
          <div className="space-y-1.5 px-1">
            <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-200"
                style={{
                  width: `${Math.max(2, (item.job?.progress ?? 0) * 100)}%`,
                }}
              />
            </div>
            <div className="text-[10px] text-text-secondary truncate">
              {item.job?.message || "Rendering…"}
            </div>
          </div>
        ) : (
          <button
            onClick={onRender}
            disabled={!canRender}
            className="w-full h-9 rounded-md bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-bg-elevated text-white text-sm font-medium transition-colors"
            title={
              !item.pipeline.planPath
                ? "Build a cut plan first"
                : "Render paced MP4"
            }
          >
            ▶ Render paced MP4
          </button>
        )}
        {renderError && (
          <div className="text-[10px] text-rose-400 px-1" title={renderError}>
            ✗ {renderError}
          </div>
        )}
      </Section>

      <Section title="Output paths">
        <PipelinePaths pipeline={item.pipeline} />
      </Section>
    </>
  );
}

// ─── Audio tab ───────────────────────────────────────────────────────────────

interface AudioTabProps {
  item: MediaItem;
  onChange: (patch: Partial<AudioSettings>) => void;
  onRender: () => void;
}

function AudioTab({ item, onChange, onRender }: AudioTabProps) {
  const audio = item.audio;
  const audioTrackCount = item.probe?.audio_tracks.length ?? 0;
  const canDuck = audioTrackCount > 1;
  const isRendering =
    item.job?.stage === "render_audio" && !item.job.error;
  const renderError =
    item.job?.stage === "render_audio" && item.job.error
      ? item.job.error
      : null;
  const audioOn = audio.enhance_speech !== "off" || audio.auto_duck;
  const canRender = audioOn && !isRendering;

  return (
    <>
      <Section title="Speech enhancement">
        <Toggle
          checked={audio.enhance_speech !== "off"}
          onChange={(on) =>
            onChange({ enhance_speech: on ? "medium" : "off" })
          }
          label="Enhance speech"
          sub="Denoise, dereverb, voice clarity boost. Adds time at render."
        />
        {audio.enhance_speech !== "off" && (
          <div className="pt-2 pl-7 space-y-1">
            <div className="text-[10px] text-text-secondary">Strength</div>
            <SegmentedControl
              options={["low", "medium", "high"] as const}
              value={audio.enhance_speech as SpeechEnhanceLevel}
              onChange={(v) => onChange({ enhance_speech: v })}
            />
          </div>
        )}
      </Section>

      <Section title="Auto-ducking">
        <Toggle
          checked={audio.auto_duck}
          disabled={!canDuck}
          onChange={(on) => onChange({ auto_duck: on })}
          label="Auto-duck other tracks"
          sub={
            canDuck
              ? "Lower music / desktop audio when you're talking. Uses VAD output."
              : "Source has only 1 audio track — nothing to duck against."
          }
        />
        {audio.auto_duck && canDuck && (
          <div className="pt-2 pl-7 space-y-1">
            <div className="flex items-center justify-between text-[10px] text-text-secondary">
              <span>Duck by</span>
              <span className="font-mono">{audio.ducking_db} dB</span>
            </div>
            <input
              type="range"
              min={-24}
              max={-2}
              step={1}
              value={audio.ducking_db}
              onChange={(e) =>
                onChange({ ducking_db: Number(e.target.value) })
              }
              className="w-full accent-accent"
            />
          </div>
        )}
      </Section>

      <Section title="Render">
        <p className="text-[10px] text-text-muted px-1 mb-2 leading-snug">
          Applies just the audio settings — no AI cuts. Produces a new MP4
          in the project's renders folder. Doesn't require running the
          pipeline first.
        </p>
        {isRendering ? (
          <div className="space-y-1.5 px-1">
            <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-200"
                style={{
                  width: `${Math.max(2, (item.job?.progress ?? 0) * 100)}%`,
                }}
              />
            </div>
            <div className="text-[10px] text-text-secondary truncate">
              {item.job?.message || "Rendering…"}
            </div>
          </div>
        ) : (
          <button
            onClick={onRender}
            disabled={!canRender}
            className="w-full h-9 rounded-md bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-bg-elevated text-white text-sm font-medium transition-colors"
            title={
              audioOn
                ? "Render audio-enhanced MP4"
                : "Turn on enhancement or ducking first"
            }
          >
            ▶ Render audio-enhanced MP4
          </button>
        )}
        {renderError && (
          <div className="text-[10px] text-rose-400 px-1" title={renderError}>
            ✗ {renderError}
          </div>
        )}
      </Section>
    </>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  sub,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  sub?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={
        "flex items-start gap-2 px-1 py-1.5 cursor-pointer " +
        (disabled ? "opacity-50 cursor-not-allowed" : "")
      }
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={
          "shrink-0 mt-0.5 inline-flex items-center w-9 h-5 rounded-full transition-colors " +
          (checked ? "bg-accent" : "bg-bg-elevated") +
          (disabled ? "" : " cursor-pointer")
        }
      >
        <span
          className={
            "inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform " +
            (checked ? "translate-x-[18px]" : "translate-x-[2px]")
          }
        />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {sub && <div className="text-[10px] text-text-muted">{sub}</div>}
      </div>
    </label>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex w-full rounded-md border border-border bg-bg p-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={
            "flex-1 px-2 py-1 text-[10px] font-medium rounded transition-colors capitalize " +
            (value === opt
              ? "bg-accent text-white"
              : "text-text-secondary hover:text-text-primary hover:bg-bg-elevated")
          }
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

// ─── Section helper ──────────────────────────────────────────────────────────

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

// ─── Stage row (Pipeline) ────────────────────────────────────────────────────

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

