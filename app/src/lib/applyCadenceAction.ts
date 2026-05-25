import type { ProposedAction } from "../api/types";
import { useProject } from "../stores/project";
import type { SpeechEnhanceLevel } from "../stores/project";
import { useSplicing } from "../stores/splicing";
import { useCadence } from "../stores/cadence";
import { useActiveProject } from "../stores/activeProject";
import { api } from "../api/client";
import { submitCadenceQuery } from "./cadenceQuery";

/**
 * Apply a Cadence-proposed action to the running app state.
 *
 * The backend produces these as typed objects; we map each type to the
 * corresponding store mutation. Unknown types throw — better to surface
 * "Cadence proposed something we can't apply" than silently ignore.
 *
 * Mutations go through the existing stores' setters so the write-through
 * to the project manifest (in stores/project.ts) keeps working — no
 * special path for AI-applied edits.
 */
export function applyCadenceAction(action: ProposedAction): void {
  const { type, params } = action;

  switch (type) {
    case "set_override": {
      const sourcePath = activeMediaPathOrThrow(
        "set_override needs an active source",
      );
      const key = stringParam(params, "key");
      const value = stringParam(params, "value");
      useProject.getState().setOverride(sourcePath, key, value);
      return;
    }

    case "clear_override": {
      const sourcePath = activeMediaPathOrThrow(
        "clear_override needs an active source",
      );
      const key = stringParam(params, "key");
      useProject.getState().setOverride(sourcePath, key, null);
      return;
    }

    case "run_audio_event_scan": {
      // Kick off the (slow) detect-events background job. Captures the
      // user's most-recent message *now* so that when the scan finishes
      // we can resume the conversation with a fresh Cadence turn —
      // user shouldn't have to retype "remove all sniffles" after
      // waiting two minutes.
      const sourcePath = activeMediaPathOrThrow(
        "run_audio_event_scan needs an active source",
      );
      const turns = useCadence.getState().turns;
      const lastUserMessage =
        [...turns].reverse().find((t) => t.role === "user")?.text ?? null;

      void api
        .detectEvents({ source_path: sourcePath })
        .then((handle) => {
          const updateMedia = useProject.getState().updateMedia;
          updateMedia(sourcePath, {
            job: {
              stage: "detect_events",
              jobId: handle.job_id,
              progress: 0,
              message: "Starting…",
            },
          });
          const unsub = api.subscribeJob(
            handle.job_id,
            (ev) => {
              if (ev._terminal) {
                unsub();
                void api.getJob(handle.job_id).then((j) => {
                  const result = j.result as
                    | { events_path?: string }
                    | null;
                  const eventsPath = result?.events_path;
                  const cur = useProject
                    .getState()
                    .media.find((m) => m.path === sourcePath);
                  updateMedia(sourcePath, {
                    pipeline: { ...cur?.pipeline, eventsPath },
                    job: null,
                  });

                  // Auto-resume the conversation. If the scan succeeded
                  // and we still have access to what the user originally
                  // asked, kick off a follow-up Cadence turn so cuts
                  // get proposed without the user needing to ask again.
                  if (
                    j.status === "done" &&
                    lastUserMessage &&
                    useActiveProject.getState().project
                  ) {
                    const followup =
                      `(Audio-event scan complete — ${
                        (result as { event_count?: number } | null)
                          ?.event_count ?? "some"
                      } events found.) ` +
                      `Continue with the previous request: "${lastUserMessage}"`;
                    void submitCadenceQuery(followup).catch(() => {
                      /* error surfaces in chat */
                    });
                  }
                });
                return;
              }
              if (typeof ev.progress === "number") {
                updateMedia(sourcePath, {
                  job: {
                    stage: "detect_events",
                    jobId: handle.job_id,
                    progress: ev.progress,
                    message: ev.message ?? "",
                  },
                });
              }
            },
            () => {},
          );
        });
      return;
    }

    case "add_splice_clip": {
      // A highlight clip: a sub-range of the active source dropped into
      // the splice timeline. Pull source path + total duration from
      // useProject (the AI tab's active item), not useSplicing — the
      // user is in the AI tab when Cadence is invoked.
      const sourcePath = activeMediaPathOrThrow(
        "add_splice_clip needs an active source",
      );
      const start = numberParam(params, "start");
      const end = numberParam(params, "end");
      if (!(end > start)) {
        throw new Error(
          `end (${end}) must be strictly greater than start (${start})`,
        );
      }
      const item = useProject
        .getState()
        .media.find((m) => m.path === sourcePath);
      const sourceDuration = item?.probe?.duration_seconds;
      if (!sourceDuration || !Number.isFinite(sourceDuration)) {
        throw new Error(
          "source duration unknown — can't add to splice timeline " +
            "(is the probe complete?)",
        );
      }
      const title =
        typeof params.title === "string" && params.title.trim()
          ? params.title.trim()
          : undefined;
      useSplicing
        .getState()
        .addClipRange(sourcePath, start, end, sourceDuration, { title });
      return;
    }

    case "add_custom_cut": {
      const sourcePath = activeMediaPathOrThrow(
        "add_custom_cut needs an active source",
      );
      const start = numberParam(params, "start");
      const end = numberParam(params, "end");
      if (!(end > start)) {
        throw new Error(
          `end (${end}) must be strictly greater than start (${start})`,
        );
      }
      const reason =
        typeof params.reason === "string" ? params.reason : "added by Cadence";
      useProject.getState().addCustomCut(sourcePath, { start, end, reason });
      return;
    }

    case "set_audio_setting": {
      const sourcePath = activeMediaPathOrThrow(
        "set_audio_setting needs an active source",
      );
      const setting = stringParam(params, "setting");
      const value = params.value;
      if (setting === "enhance_speech") {
        const allowed: SpeechEnhanceLevel[] = ["off", "low", "medium", "high"];
        if (typeof value !== "string" || !allowed.includes(value as SpeechEnhanceLevel)) {
          throw new Error(`invalid enhance_speech value: ${String(value)}`);
        }
        useProject
          .getState()
          .setAudio(sourcePath, { enhance_speech: value as SpeechEnhanceLevel });
      } else if (setting === "auto_duck") {
        if (typeof value !== "boolean") {
          throw new Error(`auto_duck expects boolean, got ${typeof value}`);
        }
        useProject.getState().setAudio(sourcePath, { auto_duck: value });
      } else if (setting === "ducking_db") {
        if (typeof value !== "number") {
          throw new Error(`ducking_db expects number, got ${typeof value}`);
        }
        useProject.getState().setAudio(sourcePath, { ducking_db: value });
      } else {
        throw new Error(`unknown audio setting: ${setting}`);
      }
      return;
    }

    default:
      throw new Error(`Cadence proposed an unknown action type: ${type}`);
  }
}

function activeMediaPathOrThrow(msg: string): string {
  const path = useProject.getState().activeMediaPath;
  if (!path) throw new Error(msg);
  return path;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string") {
    throw new Error(`expected string param '${key}', got ${typeof v}`);
  }
  return v;
}

function numberParam(params: Record<string, unknown>, key: string): number {
  const v = params[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`expected number param '${key}', got ${typeof v}`);
  }
  return v;
}
