import type { ProposedAction } from "../api/types";
import { useProject } from "../stores/project";
import type { SpeechEnhanceLevel } from "../stores/project";

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
