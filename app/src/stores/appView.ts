import { create } from "zustand";

/**
 * App-level tab selection — which top-level view the user is on.
 *
 * Lifted out of App.tsx so cross-tab UI (e.g. the Ask Cadence chat panel
 * showing a "see in Splice" link after applying a highlight clip) can
 * trigger the switch without prop-drilling through every component.
 */

export type AppView = "ai" | "splicing";

interface AppViewState {
  view: AppView;
  setView: (v: AppView) => void;
}

export const useAppView = create<AppViewState>((set) => ({
  view: "ai",
  setView: (view) => set({ view }),
}));
