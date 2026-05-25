import type { Project, ProjectSource } from "../api/types";

/**
 * The frontend works with absolute filesystem paths everywhere — that's
 * what the FFmpeg backend, the `<video>` element, and the probe endpoint
 * expect. The project manifest, by contrast, stores paths as
 * *project-relative* whenever the file lives inside the project dir, so
 * the manifest stays portable if the projects root ever moves.
 *
 * These two helpers are the only place that conversion lives. Everything
 * else should pass through them.
 */

/** Absolute path on disk for a `ProjectSource`. */
export function absoluteSourcePath(
  project: Project,
  source: ProjectSource,
): string {
  return source.ref_mode === "external"
    ? source.path
    : `${project.path}/${source.path}`;
}

/**
 * Convert an absolute media path back into the key we use in
 * `ai_state` and `splice_state.timeline` — i.e. project-relative when
 * the file is inside the project dir, else the absolute path verbatim
 * (used for `ref_mode='external'` sources).
 */
export function projectRelativePath(project: Project, absPath: string): string {
  const prefix = project.path + "/";
  if (absPath.startsWith(prefix)) {
    return absPath.substring(prefix.length);
  }
  return absPath;
}

/** Inverse of `projectRelativePath`. Useful when reading back values. */
export function resolveProjectKey(project: Project, key: string): string {
  if (key.startsWith("/")) return key; // already absolute
  return `${project.path}/${key}`;
}
