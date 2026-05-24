/**
 * Splicing view — placeholder while we design the multi-clip timeline.
 *
 * The intent: load multiple already-processed (or unprocessed) videos and
 * arrange them on a shared timeline. Consumes rendered MP4s from the AI
 * Processing tab; produces a final assembled MP4 plus a cross-clip loudness
 * normalization pass.
 */
export function SplicingView() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-text-secondary p-8">
      <div className="max-w-md text-center">
        <h2 className="text-xl font-semibold text-text-primary mb-3">
          Splicing
        </h2>
        <p className="text-sm leading-relaxed">
          Combine multiple clips on a shared timeline. Load already-processed
          videos from the AI Processing tab, reorder them, and export a single
          assembled MP4 with a final cross-clip loudness pass.
        </p>
        <p className="text-xs text-text-muted mt-4 italic">
          Coming next.
        </p>
      </div>
    </div>
  );
}
