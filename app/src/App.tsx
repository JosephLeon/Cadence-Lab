import { useEffect, useRef, useState } from "react";
import { TopBar } from "./components/TopBar";
import { useAppView } from "./stores/appView";
import { MediaBrowser } from "./components/MediaBrowser";
import { Canvas } from "./components/Canvas";
import { RightPanel } from "./components/RightPanel";
import { Timeline } from "./components/Timeline";
import { ReviewPanel } from "./components/ReviewPanel";
import { SplicingView } from "./components/SplicingView";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { CadencePanel } from "./components/CadencePanel";
import { SettingsModal } from "./components/SettingsModal";
import { api } from "./api/client";
import { keychainGet } from "./lib/keystore";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateKeysStatus } from "./hooks/useKeysStatus";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useActiveProject } from "./stores/activeProject";
import { useProject } from "./stores/project";
import { useSplicing } from "./stores/splicing";
import { useProjectSourceSync } from "./hooks/useProjectSourceSync";

export default function App() {
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const view = useAppView((s) => s.view);
  const setView = useAppView((s) => s.setView);
  const queryClient = useQueryClient();
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

  // After the sidecar is reachable, push the user's keychain-stored API
  // keys to it. The sidecar holds them in memory only for the session;
  // every cold start needs this handoff. No-op in browser dev mode (no
  // Tauri = no keychain access), where the sidecar's .env fallback wins.
  //
  // Gated by `pushedForServer` so a /health flap (serverOk false→true→
  // false→true) doesn't keep re-reading the keychain. macOS Keychain
  // Access logs every read; we want one read per genuine cold start.
  const pushedForServerRef = useRef(false);
  useEffect(() => {
    if (serverOk !== true) {
      // Reset so the next true-transition does push (cold-restart case).
      pushedForServerRef.current = false;
      return;
    }
    if (pushedForServerRef.current) return;
    pushedForServerRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const [anthropic, groq] = await Promise.all([
          keychainGet("anthropic"),
          keychainGet("groq"),
        ]);
        if (cancelled) return;
        // Only push fields where we actually have a key — sending an
        // empty string would clear the in-memory entry and leave the
        // sidecar dependent on .env, which we don't want if there's a
        // valid keychain entry pending a future write.
        const patch: { anthropic?: string; groq?: string } = {};
        if (anthropic) patch.anthropic = anthropic.trim();
        if (groq) patch.groq = groq.trim();
        if (Object.keys(patch).length > 0) {
          await api.setKeys(patch);
        }
        // Refresh any consumer of the shared keys-status cache so e.g.
        // WelcomeScreen's "Add your API keys" banner reflects the new
        // sidecar state instead of staying stuck for staleTime.
        await invalidateKeysStatus(queryClient);
      } catch (e) {
        console.warn("failed to push keychain keys to sidecar:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverOk, queryClient]);

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
      <TopBar
        serverOk={serverOk}
        view={view}
        onViewChange={setView}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {projectLoading ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
          Loading project…
        </div>
      ) : !project ? (
        <WelcomeScreen onOpenSettings={() => setSettingsOpen(true)} />
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
      {/* Ask Cadence overlay — renders on top of whichever view is active
          when the user opens it from the TopBar. Self-gates on project. */}
      {project && <CadencePanel />}
      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
