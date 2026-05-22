interface Props {
  serverOk: boolean | null;
}

export function TopBar({ serverOk }: Props) {
  return (
    <header className="h-12 shrink-0 border-b border-border flex items-center px-4 gap-3 bg-bg-panel">
      <div className="flex items-center gap-2">
        <span className="text-lg">🎬</span>
        <h1 className="font-semibold tracking-tight">Cadence Lab</h1>
      </div>

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
