import { useCallback } from "react";
import { api } from "../api/client";
import { useProject } from "../stores/project";
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

type Stage = "analyze" | "classify" | "plan" | "render";

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
      if (!mediaPath || !media) return;
      // Initial job marker
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
          updateMedia(mediaPath, {
            pipeline: { ...media.pipeline, analysisPath },
            job: null,
          });
        } else if (stage === "classify") {
          if (!media.pipeline.analysisPath)
            throw new Error("Analyze first.");
          const handle = await api.classify({
            analysis_path: media.pipeline.analysisPath,
          });
          updateMedia(mediaPath, {
            job: { stage, jobId: handle.job_id, progress: 0, message: "Starting…" },
          });
          const job = await waitForJob(handle.job_id, setJobProgress);
          const classifiedPath = (
            job.result as { classified_path: string } | null
          )?.classified_path;
          updateMedia(mediaPath, {
            pipeline: { ...media.pipeline, classifiedPath },
            job: null,
          });
        } else if (stage === "plan") {
          if (!media.pipeline.analysisPath)
            throw new Error("Analyze first.");
          if (!media.pipeline.classifiedPath)
            throw new Error("Classify first.");
          // Sync — quick interval algebra, no SSE needed.
          setJobProgress(0.5, "Computing keep-segments…");
          const res = await api.plan({
            analysis_path: media.pipeline.analysisPath,
            classified_path: media.pipeline.classifiedPath,
          });
          updateMedia(mediaPath, {
            pipeline: { ...media.pipeline, planPath: res.plan_path },
            job: null,
          });
        } else if (stage === "render") {
          if (!media.pipeline.analysisPath)
            throw new Error("Analyze first.");
          if (!media.pipeline.planPath)
            throw new Error("Build a cut plan first.");
          const handle = await api.render({
            analysis_path: media.pipeline.analysisPath,
            plan_path: media.pipeline.planPath,
            audio: {
              enhance_speech: media.audio.enhance_speech,
              auto_duck: media.audio.auto_duck,
              ducking_db: media.audio.ducking_db,
            },
          });
          updateMedia(mediaPath, {
            job: { stage, jobId: handle.job_id, progress: 0, message: "Starting…" },
          });
          const job = await waitForJob(handle.job_id, setJobProgress);
          const renderedPath = (
            job.result as { rendered_path: string } | null
          )?.rendered_path;
          updateMedia(mediaPath, {
            pipeline: { ...media.pipeline, renderedPath },
            job: null,
          });
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
    [mediaPath, media, updateMedia, setJobProgress],
  );

  return { runStage, job: media?.job ?? null, pipeline: media?.pipeline ?? {} };
}
