import { useEffect, useRef, useState } from "react";
import { useCadence, type PendingAction } from "../stores/cadence";
import { useActiveProject } from "../stores/activeProject";
import { applyCadenceAction } from "../lib/applyCadenceAction";
import { submitCadenceQuery } from "../lib/cadenceQuery";
import { useAppView } from "../stores/appView";
import { useSpliceNav } from "../stores/spliceNav";

/**
 * Slide-in chat panel for Ask Cadence. Opens from the right edge of the
 * window over the existing layout. Closes on Escape / outside-click / X.
 *
 * Layout:
 *  - Header: title + new chat + close
 *  - Scrolling message list (turns + action cards interleaved)
 *  - Sticky composer at the bottom
 */
export function CadencePanel() {
  const open = useCadence((s) => s.open);
  const setOpen = useCadence((s) => s.setOpen);
  const turns = useCadence((s) => s.turns);
  const actions = useCadence((s) => s.actions);
  const busy = useCadence((s) => s.busy);
  const error = useCadence((s) => s.error);
  const reset = useCadence((s) => s.reset);

  const project = useActiveProject((s) => s.project);

  const [input, setInput] = useState("");
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, setOpen]);

  // Autofocus when opened, autoscroll when turns/actions change.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns.length, actions.length, busy]);

  const submit = async () => {
    const text = input.trim();
    if (!text || busy || !project) return;
    setInput("");
    try {
      await submitCadenceQuery(text);
    } catch {
      // submitCadenceQuery already wrote the error to useCadence
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      onClick={() => !busy && setOpen(false)}
    >
      <div className="absolute inset-0 bg-black/30" />
      <aside
        className="relative w-[440px] max-w-[90vw] h-full bg-bg-panel border-t border-l border-border shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="h-12 shrink-0 border-b border-border flex items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-text-primary">
              Ask Cadence
            </span>
            {project && (
              <span className="text-xs text-text-muted truncate max-w-[150px]">
                · {project.name}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={reset}
              disabled={busy || turns.length === 0}
              className="h-7 px-2 rounded text-xs text-text-secondary hover:bg-bg-elevated disabled:opacity-40 disabled:cursor-not-allowed"
              title="Start a new conversation"
            >
              New chat
            </button>
            <button
              onClick={() => !busy && setOpen(false)}
              disabled={busy}
              className="h-7 w-7 rounded text-text-secondary hover:bg-bg-elevated disabled:opacity-40 flex items-center justify-center"
            >
              ✕
            </button>
          </div>
        </header>

        <div
          ref={messagesRef}
          className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0"
        >
          {turns.length === 0 ? (
            <EmptyHint />
          ) : (
            turns.map((t) => (
              <TurnView
                key={t.id}
                turn={t}
                actions={actions.filter((a) => a.turnId === t.id)}
              />
            ))
          )}
          {busy && (
            <div className="text-xs text-text-muted italic px-1">
              Cadence is thinking…
            </div>
          )}
          {error && (
            <div className="text-xs text-rose-400 border border-rose-400/30 bg-rose-400/10 rounded px-2 py-1.5">
              ✗ {error}
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="shrink-0 border-t border-border p-3 bg-bg-panel"
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder='e.g. "Remove the um at 1:23" or "Enhance speech medium"'
            rows={2}
            disabled={busy}
            className="w-full resize-none rounded-md border border-border bg-bg px-3 py-2 text-sm focus:outline-none focus:border-accent disabled:opacity-50"
          />
          <div className="flex items-center justify-between mt-2 text-[10px] text-text-muted">
            <span>Enter to send · Shift+Enter for newline</span>
            <button
              type="submit"
              disabled={!input.trim() || busy}
              className="h-7 px-3 rounded bg-accent hover:bg-accent/80 text-white text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="text-xs text-text-muted p-2 space-y-2">
      <p>
        Cadence can read your project's transcript, pauses, and fillers,
        and propose pacing or audio edits you can apply with one click.
      </p>
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-text-secondary mt-3">
          Try
        </div>
        <ExamplePill>Remove the um at 1:23</ExamplePill>
        <ExamplePill>Cut every pause longer than 2 seconds</ExamplePill>
        <ExamplePill>Enhance speech at medium</ExamplePill>
        <ExamplePill>What's the transcript around 0:30?</ExamplePill>
      </div>
    </div>
  );
}

function ExamplePill({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] text-text-secondary italic px-2 py-1 rounded bg-bg/50">
      “{children}”
    </div>
  );
}

function TurnView({
  turn,
  actions,
}: {
  turn: { role: "user" | "assistant"; text: string };
  actions: PendingAction[];
}) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-accent/15 border border-accent/30 px-3 py-2 text-sm text-text-primary whitespace-pre-wrap">
          {turn.text}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {turn.text && (
        <div className="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
          {turn.text}
        </div>
      )}
      {actions.map((a) => (
        <ActionCard key={a.id} pending={a} />
      ))}
    </div>
  );
}

function ActionCard({ pending }: { pending: PendingAction }) {
  const markStatus = useCadence((s) => s.markActionStatus);
  const setAppView = useAppView((s) => s.setView);
  const closeCadence = useCadence((s) => s.setOpen);
  const scrollSpliceToEnd = useSpliceNav((s) => s.requestScrollToEnd);

  const apply = () => {
    try {
      applyCadenceAction(pending.action);
      markStatus(pending.id, "applied");
    } catch (e) {
      markStatus(
        pending.id,
        "failed",
        e instanceof Error ? e.message : String(e),
      );
    }
  };

  // Highlight clips land in the splice timeline, not the AI tab — surface
  // a one-tap link so the user doesn't have to know where to look.
  const showSpliceLink =
    pending.status === "applied" && pending.action.type === "add_splice_clip";

  return (
    <div
      className={
        "rounded-md border px-3 py-2 text-xs " +
        (pending.status === "applied"
          ? "border-emerald-400/40 bg-emerald-400/5"
          : pending.status === "dismissed"
          ? "border-border bg-bg/50 opacity-60"
          : pending.status === "failed"
          ? "border-rose-400/40 bg-rose-400/10"
          : "border-accent/40 bg-accent/5")
      }
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[9px] uppercase tracking-wider text-text-muted">
            {pending.action.type.replace(/_/g, " ")}
          </div>
          <div className="text-sm text-text-primary mt-0.5">
            {pending.action.summary}
          </div>
          {pending.status === "failed" && pending.error && (
            <div className="text-[10px] text-rose-400 mt-1">
              ✗ {pending.error}
            </div>
          )}
        </div>
        {pending.status === "pending" && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => markStatus(pending.id, "dismissed")}
              className="h-6 px-2 rounded text-xs text-text-secondary hover:bg-bg-elevated"
            >
              Dismiss
            </button>
            <button
              onClick={apply}
              className="h-6 px-3 rounded bg-accent hover:bg-accent/80 text-white text-xs font-medium"
            >
              Apply
            </button>
          </div>
        )}
        {pending.status === "applied" && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] text-emerald-400">✓ Applied</span>
            {showSpliceLink && (
              <button
                onClick={() => {
                  setAppView("splicing");
                  closeCadence(false);
                  // Scroll the splice timeline to the end so the user
                  // lands looking at the clip they just applied rather
                  // than at the start of a long timeline.
                  scrollSpliceToEnd();
                }}
                className="text-[10px] text-accent hover:underline"
                title="Switch to the Splicing tab to see the clip"
              >
                Open in Splicing →
              </button>
            )}
          </div>
        )}
        {pending.status === "dismissed" && (
          <span className="text-[10px] text-text-muted shrink-0">
            Dismissed
          </span>
        )}
        {pending.status === "failed" && (
          <button
            onClick={apply}
            className="h-6 px-2 rounded bg-bg-elevated hover:bg-border text-xs shrink-0"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
