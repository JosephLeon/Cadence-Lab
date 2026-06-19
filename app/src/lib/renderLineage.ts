import type { Project, ProjectRenderHistoryEntry } from "../api/types";

/**
 * Render lineage detection.
 *
 * Goal: stop users from accidentally treating a previously-rendered MP4
 * as a fresh source. Doing that would force the full pipeline to run
 * again (analyze + classify, ~$0.55 in tokens) when in reality the user
 * is just trying to iterate on a render they already produced. The
 * correct workflow is to go back to the original source, tweak the
 * project state (custom cuts, overrides, audio settings), and re-render.
 *
 * The project manifest's `render_history` is the source of truth: every
 * render writes an entry with `{output, source, settings, label, …}`,
 * including the project-relative output path. When a user drops a file
 * onto the AddPanel, we check whether that path matches any entry's
 * output. If so, we know:
 *   - what original source it was derived from
 *   - what settings produced it (cuts, audio, etc.)
 *   - how to label the offer in the UI
 *
 * This module is the lookup-side; the UI uses the result to surface a
 * "this is a render of X — continue editing the source instead?" modal.
 */

export interface RenderLineageMatch {
  /** The render_history entry that matched. */
  entry: ProjectRenderHistoryEntry;
  /** Absolute filesystem path of the source video this render was made
   *  from. Null when the entry didn't record one (older splice renders). */
  sourceAbsPath: string | null;
}

/**
 * Test whether ``addedPath`` is a previously-recorded render of the
 * given project. Returns the matching history entry (with resolved
 * source path) or null.
 *
 * Matching is by absolute path: the render_history stores
 * project-relative paths (e.g. `renders/r001.intro.paced.mp4`), so we
 * combine with `project.path` to get the absolute form and compare.
 */
export function detectRenderLineage(
  project: Project,
  addedPath: string,
): RenderLineageMatch | null {
  const normalized = stripFileScheme(addedPath);
  const projectRoot = project.path;
  if (!projectRoot) return null;

  // Walk newest-first so if a user has somehow re-rendered to the same
  // path (rare; we use rNNN prefixes that should be unique) the most
  // recent metadata wins.
  for (const entry of [...project.render_history].reverse()) {
    const absOutput = joinPath(projectRoot, entry.output);
    if (samePath(absOutput, normalized)) {
      return {
        entry,
        sourceAbsPath: entry.source
          ? joinPath(projectRoot, entry.source)
          : null,
      };
    }
  }
  return null;
}

/**
 * Human-readable one-liner for the lineage modal:
 *   "AI render of intro.mov (15 paced cuts + medium neural denoise)"
 *
 * Falls back to the stored `label` when settings parsing isn't useful.
 */
export function describeLineage(match: RenderLineageMatch): string {
  const e = match.entry;
  const sourceName = match.sourceAbsPath
    ? baseName(match.sourceAbsPath)
    : null;
  const kind = e.type === "splice_render" ? "Splice render" : "AI render";
  if (sourceName) {
    return `${kind} of ${sourceName} (${e.label})`;
  }
  return `${kind} (${e.label})`;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function stripFileScheme(p: string): string {
  return p.startsWith("file://") ? p.slice("file://".length) : p;
}

function joinPath(root: string, rel: string): string {
  // Strip leading "./", "/" so we always join exactly one slash.
  const cleanRel = rel.replace(/^\.?\/+/, "");
  return root.endsWith("/")
    ? root + cleanRel
    : `${root}/${cleanRel}`;
}

/**
 * Compare two absolute paths for equality. Tolerates a single trailing
 * slash difference and a double-slash collapse, both of which crop up
 * with concatenated path components. Case-sensitive (we only run on
 * macOS / Linux where APFS / ext4 default to case-sensitive matches
 * for tools like ffprobe — being stricter here than the filesystem is
 * the safer error direction).
 */
function samePath(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\/+/g, "/").replace(/\/$/, "");
  return norm(a) === norm(b);
}

function baseName(p: string): string {
  const segs = p.split("/");
  return segs[segs.length - 1] || p;
}
