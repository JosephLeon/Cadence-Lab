import { api } from "../api/client";
import { useActiveProject } from "../stores/activeProject";
import { useCadence } from "../stores/cadence";
import { useProject } from "../stores/project";
import { useSplicing } from "../stores/splicing";
import { digestProject } from "./projectDigest";
import { projectRelativePath } from "./projectPaths";

/**
 * Send one turn of conversation to Cadence and append the result to the
 * chat. Reads the latest project + session state at call time so it
 * works whether triggered by the user typing or by an auto-resume hook
 * (e.g. when an audio-event scan completes and we want Cadence to
 * pick up where she left off).
 *
 * Returns once the assistant turn is fully appended. Throws if no
 * project is active.
 */
export async function submitCadenceQuery(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  const project = useActiveProject.getState().project;
  if (!project) throw new Error("No active project");

  const cad = useCadence.getState();
  cad.setError(null);
  cad.pushUserTurn(trimmed);
  cad.setBusy(true);
  try {
    const projState = useProject.getState();
    const splState = useSplicing.getState();
    const mediaByPath = Object.fromEntries(
      projState.media.map((m) => [m.path, m]),
    );
    const activeSourceRel = projState.activeMediaPath
      ? projectRelativePath(project, projState.activeMediaPath)
      : null;
    const digest = digestProject(project, {
      activeView: "ai",
      aiActiveMediaPath: projState.activeMediaPath,
      mediaByPath,
      spliceTimeline: splState.timeline,
      splicePlayhead: splState.playhead,
    });
    // History is the text turns up to (but not including) the one we
    // just pushed — the backend expects the new message as the
    // current turn, not part of history.
    const allTurns = useCadence.getState().turns;
    const history = allTurns
      .slice(0, -1)
      .map((t) => ({ role: t.role, text: t.text }));
    const res = await api.cadenceQuery({
      message: trimmed,
      history,
      project_slug: project.slug,
      active_source_rel: activeSourceRel,
      digest_text: digest,
    });
    cad.pushAssistantTurn(res.text, res.actions);
  } catch (e) {
    cad.setError(e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    useCadence.getState().setBusy(false);
  }
}
