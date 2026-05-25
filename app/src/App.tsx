import { useEffect, useState } from "react";
import { TopBar, type AppView } from "./components/TopBar";
import { MediaBrowser } from "./components/MediaBrowser";
import { Canvas } from "./components/Canvas";
import { RightPanel } from "./components/RightPanel";
import { Timeline } from "./components/Timeline";
import { ReviewPanel } from "./components/ReviewPanel";
import { SplicingView } from "./components/SplicingView";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { api } from "./api/client";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useActiveProject } from "./stores/activeProject";
import { useProject } from "./stores/project";
import { useSplicing } from "./stores/splicing";
import { useProjectSourceSync } from "./hooks/useProjectSourceSync";

export default function App() {
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [view, setView] = useState<AppView>("ai");
  useKeyboardShortcuts();

  // Try to restore the last-active project on mount. Failure (project was
  // deleted, manifest broken, etc.) falls through to the welcome screen.
  const rehydrate = useActiveProject((s) => s.rehydrate);
  const project = useActiveProject((s) => s.project);
  const projectLoading = useActiveProject((s) => s.loading);
  useEffect(() => {
    void rehydrate();
  }, [rehydrate]);

  // Whenever the active project changes, wipe the legacy in-memory stores
  // before the source-sync hook hydrates them from the new project's
  // manifest. Without the wipe, the sync would only *add* missing sources
  // — items left over from the previous project would persist.
  const projectSlug = project?.slug ?? null;
  useEffect(() => {
    useProject.getState().clearAll();
    useSplicing.getState().clearAll();
  }, [projectSlug]);

  // Pull sources from the project manifest into the AI + Splicing stores
  // and probe each newly-added source. Runs after the wipe above.
  useProjectSourceSync();

  // Close review on Esc
  useEffect(() => {
    if (!reviewOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setReviewOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reviewOpen]);

  // Ping the sidecar on mount. The Tauri shell will later wait on /health
  // before showing the window; in browser dev mode we just show a status
  // indicator so the user knows whether the backend is reachable.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        await api.health();
        if (!cancelled) setServerOk(true);
      } catch {
        if (!cancelled) setServerOk(false);
      }
    };
    check();
    const interval = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Layout:
  //   ┌────────────────────────────────────┐
  //   │ TopBar (full width)                │
  //   ├──────┬─────────────────────┬───────┤
  //   │ Med  │ Canvas / Review     │ Right │   <- 3-column row
  //   │ ia   │                     │ panel │      grows to fill
  //   ├──────┴─────────────────────┴───────┤
  //   │ Timeline (full width, fixed bottom)│
  //   └────────────────────────────────────┘
  return (
    <div className="h-full w-full flex flex-col">
      <TopBar serverOk={serverOk} view={view} onViewChange={setView} />
      {projectLoading ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
          Loading project…
        </div>
      ) : !project ? (
        <WelcomeScreen />
      ) : view === "ai" ? (
        <>
          <div className="flex-1 flex min-h-0">
            <MediaBrowser />
            <main className="flex-1 flex flex-col min-w-0 relative">
              {reviewOpen ? (
                <ReviewPanel onClose={() => setReviewOpen(false)} />
              ) : (
                <Canvas />
              )}
            </main>
            <RightPanel onOpenReview={() => setReviewOpen(true)} />
          </div>
          <Timeline />
        </>
      ) : (
        <SplicingView />
      )}
    </div>
  );
}
