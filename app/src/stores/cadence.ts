import { create } from "zustand";
import type { ProposedAction } from "../api/types";

/**
 * Ask Cadence — conversation state for the chat panel.
 *
 * The store holds the visible conversation (user + assistant text turns)
 * plus any currently *pending* proposed actions — the cards the user can
 * still apply. Once an action is applied (or dismissed), it moves out of
 * pending so the UI doesn't keep offering it.
 *
 * Conversation history is client-owned: every turn we send the full
 * history back to the backend along with the new user message. Keeps
 * the backend stateless and lets us clear / branch / undo at will.
 */

export interface CadenceTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface PendingAction {
  /** Per-action UI id. Unique within a turn so React can key reliably. */
  id: string;
  /** The turn this action came from — for grouping / display. */
  turnId: string;
  /** Status: pending = unanswered, applied = user clicked Apply, dismissed
   *  = user clicked X. Applied/dismissed actions stay in state so the
   *  card can show "applied" instead of vanishing. */
  status: "pending" | "applied" | "dismissed" | "failed";
  /** Error from the last apply attempt, if any. */
  error?: string;
  action: ProposedAction;
}

interface CadenceState {
  open: boolean;
  turns: CadenceTurn[];
  /** All actions ever proposed in this session, in order. Status changes
   *  in place so the UI history stays consistent. */
  actions: PendingAction[];
  /** Truthy while a query is in flight. */
  busy: boolean;
  error: string | null;

  setOpen: (open: boolean) => void;
  pushUserTurn: (text: string) => CadenceTurn;
  pushAssistantTurn: (text: string, actions: ProposedAction[]) => CadenceTurn;
  setBusy: (busy: boolean) => void;
  setError: (e: string | null) => void;
  markActionStatus: (
    id: string,
    status: PendingAction["status"],
    error?: string,
  ) => void;
  /** Wipe the conversation (and pending actions) — used by "New chat". */
  reset: () => void;
}

let _idCounter = 0;
const nextId = (prefix: string) =>
  `${prefix}-${Date.now()}-${++_idCounter}`;

export const useCadence = create<CadenceState>((set) => ({
  open: false,
  turns: [],
  actions: [],
  busy: false,
  error: null,

  setOpen: (open) => set({ open }),

  pushUserTurn: (text) => {
    const turn: CadenceTurn = {
      id: nextId("turn"),
      role: "user",
      text,
    };
    set((s) => ({ turns: [...s.turns, turn] }));
    return turn;
  },

  pushAssistantTurn: (text, actions) => {
    const turn: CadenceTurn = {
      id: nextId("turn"),
      role: "assistant",
      text,
    };
    const pending: PendingAction[] = actions.map((a) => ({
      id: nextId("act"),
      turnId: turn.id,
      status: "pending",
      action: a,
    }));
    set((s) => ({
      turns: [...s.turns, turn],
      actions: [...s.actions, ...pending],
    }));
    return turn;
  },

  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),

  markActionStatus: (id, status, error) =>
    set((s) => ({
      actions: s.actions.map((a) =>
        a.id === id ? { ...a, status, error } : a,
      ),
    })),

  reset: () =>
    set({ turns: [], actions: [], busy: false, error: null }),
}));
