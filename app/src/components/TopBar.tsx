import { ProjectSwitcher } from "./ProjectSwitcher";
import { useActiveProject } from "../stores/activeProject";
import { useCadence } from "../stores/cadence";

export type AppView = "ai" | "splicing";

interface Props {
  serverOk: boolean | null;
  view: AppView;
  onViewChange: (view: AppView) => void;
  onOpenSettings: () => void;
}

export function TopBar({ serverOk, view, onViewChange, onOpenSettings }: Props) {
  const hasProject = useActiveProject((s) => s.project !== null);
  const openCadence = useCadence((s) => s.setOpen);
  // Only surface the server indicator when it's actually informative —
  // i.e. while we're still connecting on first launch, or after the
  // sidecar dies. The healthy state is the 99% case and just adds noise.
  const showServerStatus = serverOk !== true;

  return (
    <header className="h-12 shrink-0 border-t border-b border-border flex items-center px-4 gap-3 bg-bg-panel">
      <h1 className="font-semibold tracking-tight">Cadence Lab</h1>

      <ProjectSwitcher />

      {hasProject && (
        <nav className="flex items-center gap-1 ml-2">
          <TabButton
            label="AI Processing"
            active={view === "ai"}
            onClick={() => onViewChange("ai")}
          />
          <TabButton
            label="Splicing"
            active={view === "splicing"}
            onClick={() => onViewChange("splicing")}
          />
        </nav>
      )}

      <div className="flex-1" />

      {/* Ask Cadence trigger — only meaningful inside a project. Looks
          like an input but actually opens the chat panel where the
          conversation happens. Click or focus to open. */}
      {hasProject && (
        <button
          onClick={() => openCadence(true)}
          className="h-8 w-96 max-w-full rounded-md border border-border bg-bg px-3 text-sm text-left text-text-muted hover:border-accent hover:text-text-secondary transition-colors flex items-center gap-2"
          title="Open Ask Cadence (natural-language editing)"
        >
          <span className="text-text-muted">✨</span>
          <span className="truncate">
            Ask Cadence — e.g. "Remove the um at 1:23"
          </span>
        </button>
      )}

      {showServerStatus && (
        <div className="flex items-center gap-2 text-xs">
          <span
            className={
              "inline-block h-2 w-2 rounded-full " +
              (serverOk === null
                ? "bg-text-muted animate-pulse"
                : "bg-rose-500")
            }
          />
          <span className="text-text-secondary">
            {serverOk === null ? "Connecting…" : "Disconnected"}
          </span>
        </div>
      )}

      <button
        onClick={onOpenSettings}
        className="h-8 w-8 rounded-md text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-colors flex items-center justify-center text-base"
        title="Settings — API keys"
      >
        ⚙
      </button>
    </header>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "h-8 px-3 text-sm rounded-md transition-colors " +
        (active
          ? "bg-bg text-text-primary"
          : "text-text-secondary hover:text-text-primary hover:bg-bg/50")
      }
    >
      {label}
    </button>
  );
}
