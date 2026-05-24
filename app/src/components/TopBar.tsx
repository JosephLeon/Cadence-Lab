export type AppView = "ai" | "splicing";

interface Props {
  serverOk: boolean | null;
  view: AppView;
  onViewChange: (view: AppView) => void;
}

export function TopBar({ serverOk, view, onViewChange }: Props) {
  return (
    <header className="h-12 shrink-0 border-b border-border flex items-center px-4 gap-3 bg-bg-panel">
      <div className="flex items-center gap-2">
        <img
          src="/icon.png"
          alt=""
          className="h-6 w-6 rounded-md shadow-sm"
        />
        <h1 className="font-semibold tracking-tight">Cadence Lab</h1>
      </div>

      <nav className="flex items-center gap-1 ml-4">
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

      <div className="flex-1" />

      {/* Command bar placeholder — text-based conversational editing */}
      <input
        type="text"
        placeholder="Ask Cadence (e.g. ‘trim silence at 0:30’)"
        className="h-8 w-96 max-w-full rounded-md border border-border bg-bg px-3 text-sm placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors"
        disabled
      />

      <div className="flex items-center gap-2 text-xs">
        <span
          className={
            "inline-block h-2 w-2 rounded-full " +
            (serverOk === null
              ? "bg-text-muted animate-pulse"
              : serverOk
              ? "bg-emerald-500"
              : "bg-rose-500")
          }
        />
        <span className="text-text-secondary">
          {serverOk === null
            ? "Connecting…"
            : serverOk
            ? "Server"
            : "Disconnected"}
        </span>
      </div>
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
