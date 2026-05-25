import { useMemo, useState } from "react";
import { useProject } from "../stores/project";
import { useActiveProject } from "../stores/activeProject";
import { absoluteSourcePath } from "../lib/projectPaths";
import type { MediaItem } from "../stores/project";
import { MediaAddPanel } from "./MediaAddPanel";

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function MediaBrowser() {
  const media = useProject((s) => s.media);
  const active = useProject((s) => s.activeMediaPath);
  const removeMedia = useProject((s) => s.removeMedia);
  const setActive = useProject((s) => s.setActive);
  const project = useActiveProject((s) => s.project);

  const [dragOver, setDragOver] = useState(false);

  // Partition the media list into Sources vs Renders based on the active
  // project's manifest. Sources are the user-added videos; renders are
  // outputs we surface so the user can play / pipeline / drag them into
  // the splice timeline. Items with no matching project entry (legacy /
  // ad-hoc adds) fall into Sources.
  const { sourceItems, renderItems, renderLabelByPath } = useMemo(() => {
    if (!project) {
      return {
        sourceItems: media,
        renderItems: [] as MediaItem[],
        renderLabelByPath: {} as Record<string, { id: string; label: string }>,
      };
    }
    const sourceAbsSet = new Set(
      project.sources.map((s) => absoluteSourcePath(project, s)),
    );
    const labels: Record<string, { id: string; label: string }> = {};
    for (const r of project.render_history) {
      labels[`${project.path}/${r.output}`] = { id: r.id, label: r.label };
    }
    const sources: MediaItem[] = [];
    const renders: MediaItem[] = [];
    for (const m of media) {
      if (sourceAbsSet.has(m.path)) sources.push(m);
      else if (m.path in labels) renders.push(m);
      else sources.push(m); // ad-hoc adds — treat as sources
    }
    // Newest renders first: reverse so latest rNNN is at the top.
    renders.reverse();
    return {
      sourceItems: sources,
      renderItems: renders,
      renderLabelByPath: labels,
    };
  }, [media, project]);

  return (
    <aside
      className="w-72 shrink-0 border-r border-border bg-bg-panel flex flex-col relative"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        // Files dropped on the panel are handled by MediaAddPanel via its
        // own input; here we just absorb the drop so the browser doesn't
        // navigate to the file URL.
      }}
    >
      <div className="h-10 shrink-0 border-b border-border flex items-center px-3">
        <h2 className="text-sm font-medium text-text-secondary uppercase tracking-wider">
          Media
        </h2>
      </div>

      <MediaAddPanel />

      {/* Media list. Two groups: user-added Sources first, then auto-tracked
          Renders so they're one click away for play / pipeline / splicing.
          Single scroll container — the whole list is scrollable as one. */}
      <div className="flex-1 overflow-y-auto">
        {media.length === 0 ? (
          <div className="p-4 text-sm text-text-muted text-center">
            No media yet.
            <br />
            Drop a video here or use the buttons above.
          </div>
        ) : (
          <div className="p-2 space-y-3">
            <MediaGroup
              title={`Sources (${sourceItems.length})`}
              items={sourceItems}
              active={active}
              onSelect={setActive}
              onRemove={removeMedia}
            />
            {renderItems.length > 0 && (
              <MediaGroup
                title={`Renders (${renderItems.length})`}
                items={renderItems}
                active={active}
                onSelect={setActive}
                onRemove={removeMedia}
                labelByPath={renderLabelByPath}
              />
            )}
          </div>
        )}
      </div>

      {/* Drag overlay */}
      {dragOver && (
        <div className="absolute inset-0 bg-accent/15 border-2 border-dashed border-accent rounded-md pointer-events-none flex items-center justify-center z-20">
          <div className="text-accent font-medium">Drop to upload</div>
        </div>
      )}
    </aside>
  );
}

// Re-export for compatibility with anyone importing fmtBytes
export { fmtBytes };

function MediaGroup({
  title,
  items,
  active,
  onSelect,
  onRemove,
  labelByPath,
}: {
  title: string;
  items: MediaItem[];
  active: string | null;
  onSelect: (path: string) => void;
  onRemove: (path: string) => void;
  labelByPath?: Record<string, { id: string; label: string }>;
}) {
  return (
    <div>
      <h3 className="text-[10px] font-medium tracking-widest uppercase text-text-muted px-1 mb-1">
        {title}
      </h3>
      <ul className="space-y-1">
        {items.map((m) => (
          <MediaRow
            key={m.path}
            item={m}
            isActive={active === m.path}
            onSelect={onSelect}
            onRemove={onRemove}
            renderMeta={labelByPath?.[m.path]}
          />
        ))}
      </ul>
    </div>
  );
}

function MediaRow({
  item,
  isActive,
  onSelect,
  onRemove,
  renderMeta,
}: {
  item: MediaItem;
  isActive: boolean;
  onSelect: (path: string) => void;
  onRemove: (path: string) => void;
  renderMeta?: { id: string; label: string };
}) {
  const name = item.path.split("/").pop() ?? item.path;
  return (
    <li
      onClick={() => onSelect(item.path)}
      className={
        "group cursor-pointer rounded-md px-2 py-2 transition-colors " +
        (isActive
          ? "bg-accent/15 border border-accent/40"
          : "border border-transparent hover:bg-bg-elevated")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          {renderMeta ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[10px] font-mono text-text-muted shrink-0">
                {renderMeta.id}
              </span>
              <span
                className="text-sm font-medium truncate"
                title={renderMeta.label}
              >
                {renderMeta.label}
              </span>
            </div>
          ) : (
            <div className="text-sm font-medium truncate" title={item.path}>
              {name}
            </div>
          )}
          <div className="text-xs text-text-muted truncate" title={item.path}>
            {renderMeta ? name : item.path}
          </div>
        </div>
        <button
          className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-rose-400 text-xs px-1 transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(item.path);
          }}
          title={
            renderMeta
              ? "Remove from view (file stays on disk)"
              : "Remove from project"
          }
        >
          ✕
        </button>
      </div>

      {item.status === "loading" && (
        <div className="mt-1 text-xs text-text-secondary">Probing…</div>
      )}
      {item.status === "error" && (
        <div
          className="mt-1 text-xs text-rose-400 truncate"
          title={item.error}
        >
          ✗ {item.error ?? "Failed"}
        </div>
      )}
      {item.status === "ready" && item.probe && (
        <div className="mt-1 flex gap-3 text-xs text-text-secondary">
          <span>{fmtDuration(item.probe.duration_seconds)}</span>
          {item.probe.width && (
            <span>
              {item.probe.width}×{item.probe.height}
            </span>
          )}
          {item.probe.audio_tracks.length > 0 && (
            <span>{item.probe.audio_tracks.length}ch</span>
          )}
        </div>
      )}
    </li>
  );
}
