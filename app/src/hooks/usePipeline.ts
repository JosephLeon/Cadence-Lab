import { useCallback } from "react";
import { api } from "../api/client";
import { useProject } from "../stores/project";
import { useActiveProject } from "../stores/activeProject";
import type { JobEvent, JobStatusResponse } from "../api/types";

/**
 * One hook to drive the four pipeline stages against a single media item.
 *
 * Each stage runner:
 * 1. Sets the media's `job` state to indicate "running"
 * 2. For async stages (analyze/classify/render): opens an SSE connection to
 *    the sidecar, mirrors progress events into the store, and on terminal
 *    fetches the final job result.
 * 3. For sync stages (plan): just awaits the HTTP response.
 * 4. On success: writes the produced artifact path into the media's
 *    `pipeline` state so downstream stages can see it.
 * 5. Clears the job marker.
 *
 * Errors land back in the store as `job.error` (and the job entry stays
 * around until the next run starts) so the UI can show them inline.
 */

type Stage =
  | "analyze"
  | "classify"
  | "plan"
  | "render"
  | "render_audio"
  | "detect_events";

/**
 * Block on an async job: subscribe to its SSE event stream, mirror progress
 * into a callback, and resolve with the final result (or reject with the error)
 * when the terminal event arrives.
 */
function waitForJob(
  jobId: string,
  onProgress: (frac: number, message: string) => void,
): Promise<JobStatusResponse> {
  return new Promise((resolve, reject) => {
    const unsubscribe = api.subscribeJob(
      jobId,
      (ev: JobEvent) => {
        if (ev._terminal) {
          unsubscribe();
          // Fetch the final job state to get the structured result/error.
          api
            .getJob(jobId)
            .then((j) => {
              if (j.status === "done") resolve(j);
              else reject(new Error(j.error ?? `Job failed (${ev.status})`));
            })
            .catch(reject);
          return;
        }
        if (typeof ev.progress === "number") {
          onProgress(ev.progress, ev.message ?? "");
        }
      },
      (err) => {
        // SSE connection error — likely the sidecar died.
        reject(new Error("Lost connection to server"));
        void err;
      },
    );
  });
}

export function usePipeline(mediaPath: string | null) {
  const media = useProject((s) =>
    mediaPath ? s.media.find((m) => m.path === mediaPath) : undefined,
  );
  const updateMedia = useProject((s) => s.updateMedia);

  const setJobProgress = useCallback(
    (frac: number, message: string) => {
      if (!mediaPath) return;
      updateMedia(mediaPath, {
        job: {
          stage:
            (useProject.getState().media.find((m) => m.path === mediaPath)
              ?.job?.stage as Stage) ?? "analyze",
          progress: frac,
          message,
        },
      });
    },
    [mediaPath, updateMedia],
  );

  const runStage = useCallback(
    async (stage: Stage) => {
      if (!mediaPath) return;
      // Always read the latest media snapshot from the store rather than
      // the React closure. When `runAllStages` chains stages, the next
      // stage's prerequisite check must see the artifact paths the
      // previous stage just wrote — those updates are in the store, not
      // in the closure-captured `media` from the time runStage was
      // memoized.
      const latest = () =>
        useProject.getState().media.find((m) => m.path === mediaPath);
      if (!latest()) return;
      updateMedia(mediaPath, {
        job: { stage, progress: 0, message: "Starting…" },
      });

      try {
        if (stage === "analyze") {
          const handle = await api.analyze({ source_path: mediaPath });
          updateMedia(mediaPath, {
            job: { stage, jobId: handle.job_id, progress: 0, message: "Starting…" },
          });
          const job = await waitForJob(handle.job_id, setJobProgress);
          const analysisPath = (job.result as { analysis_path: string } | null)
            ?.analysis_path;
          const cur = latest();
          updateMedia(mediaPath, {
            pipeline: { ...cur?.pipeline, analysisPath },
            job: null,
          });
        } else if (stage === "classify") {
          const cur = latest();
          if (!cur?.pipeline.analysisPath)
            throw new Error("Analyze first.");
          const handle = await api.classify({
            analysis_path: cur.pipeline.analysisPath,
          });
          updateMedia(mediaPath, {
            job: { stage, jobId: handle.job_id, progress: 0, message: "Starting…" },
          });
          const job = await waitForJob(handle.job_id, setJobProgress);
          const classifiedPath = (
            job.result as { classified_path: string } | null
          )?.classified_path;
          const after = latest();
          updateMedia(mediaPath, {
            pipeline: { ...after?.pipeline, classifiedPath },
            job: null,
          });
        } else if (stage === "plan") {
          const cur = latest();
          if (!cur?.pipeline.analysisPath)
            throw new Error("Analyze first.");
          if (!cur.pipeline.classifiedPath)
            throw new Error("Classify first.");
          setJobProgress(0.5, "Computing keep-segments…");
          const res = await api.plan({
            analysis_path: cur.pipeline.analysisPath,
            classified_path: cur.pipeline.classifiedPath,
          });
          const after = latest();
          updateMedia(mediaPath, {
            pipeline: { ...after?.pipeline, planPath: res.plan_path },
            job: null,
          });
        } else if (stage === "detect_events") {
          // Opt-in: scans for non-speech sounds (sniffles, throat clears,
          // coughs, etc.) so Cadence can offer "remove all sniffles"
          // style cuts. Slow — runs as a background job with progress.
          const handle = await api.detectEvents({ source_path: mediaPath });
          updateMedia(mediaPath, {
            job: { stage, jobId: handle.job_id, progress: 0, message: "Starting…" },
          });
          const job = await waitForJob(handle.job_id, setJobProgress);
          const eventsPath = (job.result as { events_path: string } | null)
            ?.events_path;
          const after = latest();
          updateMedia(mediaPath, {
            pipeline: { ...after?.pipeline, eventsPath },
            job: null,
          });
        } else if (stage === "render" || stage === "render_audio") {
          const cur = latest();
          if (!cur) return;
          const projectSlug = useActiveProject.getState().project?.slug;
          const renderReq: Parameters<typeof api.render>[0] =
            stage === "render"
              ? (() => {
                  if (!cur.pipeline.analysisPath)
                    throw new Error("Analyze first.");
                  if (!cur.pipeline.planPath)
                    throw new Error("Build a cut plan first.");
                  return {
                    analysis_path: cur.pipeline.analysisPath,
                    plan_path: cur.pipeline.planPath,
                    audio: {
                      enhance_speech: cur.audio.enhance_speech,
                      auto_duck: cur.audio.auto_duck,
                      ducking_db: cur.audio.ducking_db,
                    },
                    // Always send current overrides + custom_cuts so the
                    // backend re-plans on top of the latest session state.
                    // Plan is interval algebra — basically free.
                    overrides: cur.overrides,
                    custom_cuts: cur.customCuts.map((c) => ({
                      start: c.start,
                      end: c.end,
                      reason: c.reason,
                    })),
                    project_slug: projectSlug,
                  };
                })()
              : {
                  source_path: mediaPath,
                  audio: {
                    enhance_speech: cur.audio.enhance_speech,
                    auto_duck: cur.audio.auto_duck,
                    ducking_db: cur.audio.ducking_db,
                  },
                  project_slug: projectSlug,
                };
          const handle = await api.render(renderReq);
          updateMedia(mediaPath, {
            job: { stage, jobId: handle.job_id, progress: 0, message: "Starting…" },
          });
          const job = await waitForJob(handle.job_id, setJobProgress);
          const result = job.result as
            | { rendered_path: string; project_slug?: string }
            | null;
          const renderedPath = result?.rendered_path;
          const after = latest();
          updateMedia(mediaPath, {
            pipeline: { ...after?.pipeline, renderedPath },
            job: null,
          });
          if (result?.project_slug) {
            void useActiveProject.getState().open(result.project_slug);
          }
        }
      } catch (e) {
        updateMedia(mediaPath, {
          job: {
            stage,
            progress: 0,
            message: "",
            error: e instanceof Error ? e.message : String(e),
          },
        });
      }
    },
    [mediaPath, updateMedia, setJobProgress],
  );

  /**
   * Run analyze → classify → plan sequentially, skipping any stage whose
   * artifact already exists. Stops on the first failure (the failing
   * stage's error lands in `media.job.error` via runStage). Safe to call
   * even when all stages are already done — it's a no-op.
   *
   * Reads from the *latest* store state at each step rather than the
   * `media` closure, so subsequent stages see the artifact paths the
   * previous stage just wrote.
   */
  const runAllStages = useCallback(async () => {
    if (!mediaPath) return;
    const latest = () =>
      useProject.getState().media.find((m) => m.path === mediaPath);
    if (!latest()?.pipeline.analysisPath) {
      await runStage("analyze");
      if (latest()?.job?.error) return;
    }
    if (!latest()?.pipeline.classifiedPath) {
      await runStage("classify");
      if (latest()?.job?.error) return;
    }
    if (!latest()?.pipeline.planPath) {
      await runStage("plan");
    }
  }, [mediaPath, runStage]);

  return {
    runStage,
    runAllStages,
    job: media?.job ?? null,
    pipeline: media?.pipeline ?? {},
  };
}
