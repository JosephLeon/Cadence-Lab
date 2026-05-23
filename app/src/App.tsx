import { useEffect, useState } from "react";
import { TopBar } from "./components/TopBar";
import { MediaBrowser } from "./components/MediaBrowser";
import { Canvas } from "./components/Canvas";
import { RightPanel } from "./components/RightPanel";
import { Timeline } from "./components/Timeline";
import { ReviewPanel } from "./components/ReviewPanel";
import { api } from "./api/client";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";

export default function App() {
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  useKeyboardShortcuts();

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
      <TopBar serverOk={serverOk} />
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
    </div>
  );
}
