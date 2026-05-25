import { useEffect, useRef } from "react";
import { api } from "../api/client";
import { useActiveProject } from "../stores/activeProject";
import { useProject } from "../stores/project";
import { manifestToClip, useSplicing } from "../stores/splicing";
import type { Project } from "../api/types";
import {
  absoluteSourcePath,
  projectRelativePath,
  resolveProjectKey,
} from "../lib/projectPaths";

/**
 * Keep the legacy AI (`useProject.media`) and Splicing (`useSplicing.library`)
 * source lists in sync with the active project's `sources` array.
 *
 * The two legacy stores remain the in-memory caches for session-only state
 * (probe results, job progress, audio/override edits, etc.), but the *set
 * of sources* is owned by the project manifest. When the manifest changes
 * — because the user added a source, removed one, or switched projects —
 * this hook adds/removes corresponding items in both stores and kicks off
 * a fresh probe for any newly-added source.
 *
 * Once steps 3d–3f are done (per-source AI state + splice timeline state
 * persisted in the manifest), the legacy stores' fields beyond session
 * data will also be hydrated from the project here.
 */
export function useProjectSourceSync() {
  const project = useActiveProject((s) => s.project);
  const lastHydratedSlug = useRef<string | null>(null);

  useEffect(() => {
    if (!project) {
      lastHydratedSlug.current = null;
      return;
    }
    syncStoresWithProject(project);

    // One-shot hydration of the splice timeline per project switch. After
    // this initial seed, every timeline mutation pushes its own update
    // back into the manifest via `persistSpliceState`, so re-running on
    // each refresh would just clobber the user's in-progress edits.
    if (lastHydratedSlug.current !== project.slug) {
      lastHydratedSlug.current = project.slug;
      hydrateSpliceTimeline(project);
    }
  }, [project]);
}

function hydrateSpliceTimeline(project: Project) {
  const resolveKey = (key: string) => resolveProjectKey(project, key);
  const resolveSourceDuration = (absPath: string): number => {
    // Best-effort: read from the library if probed already. Falls back to
    // (end - start) of the manifest entry, which is the visible length;
    // the sprite thumbnail math degrades gracefully when this is wrong.
    const match = useSplicing
      .getState()
      .library.find((m) => m.path === absPath);
    return match?.probe?.duration_seconds ?? 0;
  };
  const timeline = project.splice_state.timeline.map((entry) => {
    const clip = manifestToClip(entry, resolveKey, resolveSourceDuration);
    // Fill in sourceDuration once the source probes complete — handled by
    // a follow-up effect (TODO when we wire it). For now, an initial
    // 0-fallback is acceptable for display.
    return clip;
  });
  useSplicing
    .getState()
    .hydrateFromProject(timeline, project.splice_state.last_space_seconds);
}

function syncStoresWithProject(project: Project) {
  const desiredAbsPaths = project.sources.map((s) =>
    absoluteSourcePath(project, s),
  );
  const desiredSet = new Set(desiredAbsPaths);

  // ─── useProject (AI tab) ─────────────────────────────────────────────────
  // Hydrate per-source AI state (audio + overrides) from the project
  // manifest on add. Existing items aren't touched so an in-flight edit
  // isn't clobbered by a backend refresh.
  {
    const { media, addMedia, updateMedia, removeMedia } =
      useProject.getState();
    const currentPaths = new Set(media.map((m) => m.path));

    for (const p of desiredAbsPaths) {
      if (!currentPaths.has(p)) {
        const key = projectRelativePath(project, p);
        const aiState = project.ai_state[key];
        addMedia(p, {
          audio: aiState?.audio,
          overrides: aiState?.overrides,
        });
        void probeIntoAITab(p, updateMedia);
      }
    }
    for (const m of media) {
      if (!desiredSet.has(m.path)) removeMedia(m.path);
    }
  }

  // ─── useSplicing (Splice tab) ────────────────────────────────────────────
  {
    const { library, addMedia, updateMedia, removeMedia } =
      useSplicing.getState();
    const currentPaths = new Set(library.map((m) => m.path));

    for (const p of desiredAbsPaths) {
      if (!currentPaths.has(p)) {
        addMedia(p);
        void probeIntoSplice(p, updateMedia);
      }
    }
    for (const m of library) {
      if (!desiredSet.has(m.path)) removeMedia(m.path);
    }
  }
}

async function probeIntoAITab(
  path: string,
  updateMedia: ReturnType<typeof useProject.getState>["updateMedia"],
): Promise<void> {
  try {
    const res = await api.probe(path);
    const p = res.paths;
    // Derive the mic WAV path from the analysis dir + source stem — matches
    // what `paths.mic_wav_path()` writes in the backend.
    const stem = path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    const dir = p.analysis.substring(0, p.analysis.lastIndexOf("/"));
    const micWavPath = `${dir}/${stem}.mic.16k.wav`;
    updateMedia(path, {
      probe: res.source,
      canonical: p,
      status: "ready",
      pipeline: {
        analysisPath: p.analysis_exists ? p.analysis : undefined,
        classifiedPath: p.classified_exists ? p.classified : undefined,
        planPath: p.plan_exists ? p.plan : undefined,
        renderedPath: p.rendered_exists ? p.rendered : undefined,
        micWavPath: p.analysis_exists ? micWavPath : undefined,
      },
    });
  } catch (e) {
    updateMedia(path, {
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function probeIntoSplice(
  path: string,
  updateMedia: ReturnType<typeof useSplicing.getState>["updateMedia"],
): Promise<void> {
  try {
    const res = await api.probe(path);
    updateMedia(path, {
      probe: res.source,
      canonical: res.paths,
      status: "ready",
    });
  } catch (e) {
    updateMedia(path, {
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
