import { create } from "zustand";
import type { CanonicalPaths, SourceProbe } from "../api/types";

/**
 * Project state — the in-memory model of what the user is currently editing.
 * Persistence (saving project state to disk, recent projects, etc.) is a
 * later concern.
 */

/** Per-media pipeline state. Tracks which stages have a known output path. */
export interface PipelineState {
  analysisPath?: string;
  classifiedPath?: string;
  planPath?: string;
  renderedPath?: string;
  /** Mic-only 16k WAV produced during ingest; used for per-cut audio clips. */
  micWavPath?: string;
}

/**
 * Per-classifier-item override decisions. Key format matches the backend:
 *   - "pause:5" → "cut" | "trim" | "keep"
 *   - "filler:3" → "cut" | "keep"
 *   - "retake:0" → "reject"
 * Absent key = use classifier's original decision.
 */
export type OverrideMap = Record<string, string>;

/** Per-media job state. Only one stage at a time runs against a single clip. */
export interface JobState {
  stage: "analyze" | "classify" | "plan" | "render";
  jobId?: string;       // undefined for sync stages (plan)
  progress: number;
  message: string;
  error?: string;
}

/**
 * AI Audio enhancement settings. Currently UI-only: backend wiring (ffmpeg
 * filter graph + ducking sidechain) is a follow-on phase. Settings live on
 * the media item so toggling them doesn't blow away when the user switches
 * clips and back.
 */
export type SpeechEnhanceLevel = "off" | "low" | "medium" | "high";

export interface AudioSettings {
  enhance_speech: SpeechEnhanceLevel;
  auto_duck: boolean;
  ducking_db: number;  // negative; e.g. -8 lowers other tracks by 8 dB
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  enhance_speech: "off",
  auto_duck: false,
  ducking_db: -8,
};

export interface MediaItem {
  /** Absolute path on the user's filesystem */
  path: string;
  /** Probe info; null while loading or if probe failed */
  probe: SourceProbe | null;
  /** Canonical output paths for this source */
  canonical?: CanonicalPaths;
  /** Loading / error state for the initial probe */
  status: "loading" | "ready" | "error";
  error?: string;
  /** Pipeline artifact paths — populated by stage completions */
  pipeline: PipelineState;
  /** Active job, if any */
  job: JobState | null;
  /** Pending review overrides (cleared after Apply or Reset) */
  overrides: OverrideMap;
  /** AI audio enhancement settings applied at render time */
  audio: AudioSettings;
}

/** Playback state for the active video. */
export interface PlaybackState {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
}

interface ProjectState {
  media: MediaItem[];
  activeMediaPath: string | null;
  playback: PlaybackState;

  addMedia: (path: string) => void;
  updateMedia: (path: string, patch: Partial<MediaItem>) => void;
  removeMedia: (path: string) => void;
  setActive: (path: string | null) => void;
  setPlayback: (patch: Partial<PlaybackState>) => void;
  setOverride: (mediaPath: string, key: string, value: string | null) => void;
  clearOverrides: (mediaPath: string) => void;
  setAudio: (mediaPath: string, patch: Partial<AudioSettings>) => void;
  /** Wipe all media + playback. Called when the active project changes so
   *  the AI tab doesn't show stale items from a different workspace.
   *  Step 3 will make this redundant by sourcing media from the project
   *  manifest directly. */
  clearAll: () => void;
}

export const useProject = create<ProjectState>((set) => ({
  media: [],
  activeMediaPath: null,
  playback: { currentTime: 0, duration: 0, isPlaying: false },

  setPlayback: (patch) =>
    set((s) => ({ playback: { ...s.playback, ...patch } })),

  addMedia: (path) =>
    set((s) => {
      if (s.media.some((m) => m.path === path)) return s;
      return {
        media: [
          ...s.media,
          {
            path,
            probe: null,
            status: "loading",
            pipeline: {},
            job: null,
            overrides: {},
            audio: { ...DEFAULT_AUDIO_SETTINGS },
          },
        ],
        activeMediaPath: s.activeMediaPath ?? path,
      };
    }),

  updateMedia: (path, patch) =>
    set((s) => ({
      media: s.media.map((m) => (m.path === path ? { ...m, ...patch } : m)),
    })),

  removeMedia: (path) =>
    set((s) => ({
      media: s.media.filter((m) => m.path !== path),
      activeMediaPath:
        s.activeMediaPath === path ? null : s.activeMediaPath,
    })),

  setActive: (path) =>
    set({
      activeMediaPath: path,
      // Reset playback when switching clips so the timeline cursor doesn't
      // sit at an inherited position from the previous video.
      playback: { currentTime: 0, duration: 0, isPlaying: false },
    }),

  setOverride: (mediaPath, key, value) =>
    set((s) => ({
      media: s.media.map((m) => {
        if (m.path !== mediaPath) return m;
        const next = { ...m.overrides };
        // Passing `null` clears the override (revert to classifier default).
        if (value === null) {
          delete next[key];
        } else {
          next[key] = value;
        }
        return { ...m, overrides: next };
      }),
    })),

  clearOverrides: (mediaPath) =>
    set((s) => ({
      media: s.media.map((m) =>
        m.path === mediaPath ? { ...m, overrides: {} } : m,
      ),
    })),

  setAudio: (mediaPath, patch) =>
    set((s) => ({
      media: s.media.map((m) =>
        m.path === mediaPath ? { ...m, audio: { ...m.audio, ...patch } } : m,
      ),
    })),

  clearAll: () =>
    set({
      media: [],
      activeMediaPath: null,
      playback: { currentTime: 0, duration: 0, isPlaying: false },
    }),
}));
