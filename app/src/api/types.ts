// Mirror of the Pydantic models on the Python side. Kept hand-written
// rather than codegen'd because there aren't many of them yet and changes
// are infrequent — once the schema stabilizes we may switch to
// openapi-typescript pointed at /openapi.json.

export interface AudioTrack {
  index: number;
  codec: string;
  channels: number;
  sample_rate: number;
  language: string | null;
  title: string | null;
  duration_seconds: number | null;
}

export interface SourceProbe {
  path: string;
  duration_seconds: number;
  container: string;
  video_codec: string | null;
  width: number | null;
  height: number | null;
  frame_rate: number | null;
  is_variable_frame_rate: boolean;
  audio_tracks: AudioTrack[];
}

export interface CanonicalPaths {
  analysis: string;
  classified: string;
  plan: string;
  rendered: string;
  mic_wav: string;
  analysis_exists: boolean;
  classified_exists: boolean;
  plan_exists: boolean;
  rendered_exists: boolean;
  mic_wav_exists: boolean;
  events: string;
  events_exists: boolean;
  frame_index: string;
  frame_index_exists: boolean;
}

// ─── Projects (workspace) ──────────────────────────────────────────────────

export interface ProjectSource {
  path: string;
  ref_mode: "copied" | "external";
  original_path: string | null;
  added_at: string;
}

export interface ProjectAudioSettings {
  enhance_speech: "off" | "low" | "medium" | "high";
  enhance_engine: "classical" | "neural";
  auto_duck: boolean;
  ducking_db: number;
}

export interface ProjectCustomCut {
  start: number;
  end: number;
  reason: string;
}

export interface ProjectAIState {
  audio: ProjectAudioSettings;
  overrides: Record<string, string>;
  custom_cuts: ProjectCustomCut[];
}

export interface ProjectSpliceClip {
  kind: "video" | "blank";
  source_path: string | null;
  source_start: number;
  source_end: number;
  duration: number;
  title?: string | null;
}

export interface ProjectSpliceState {
  timeline: ProjectSpliceClip[];
  last_space_seconds: number;
}

export interface ProjectRenderHistoryEntry {
  id: string;
  type: "ai_render" | "splice_render";
  source: string | null;
  input_render_id: string | null;
  settings: Record<string, unknown>;
  output: string;
  label: string;
  timestamp: string;
  size_bytes: number | null;
}

export interface Project {
  schema_version: number;
  slug: string;
  name: string;
  created_at: string;
  modified_at: string;
  sources: ProjectSource[];
  ai_state: Record<string, ProjectAIState>;
  splice_state: ProjectSpliceState;
  render_history: ProjectRenderHistoryEntry[];
  /** Absolute filesystem path of the project directory. Populated by
   *  the backend on load — useful for resolving project-relative source
   *  paths to absolute paths the rest of the API expects. */
  path: string;
}

export interface ProjectSummary {
  slug: string;
  name: string;
  created_at?: string;
  modified_at?: string;
  source_count?: number;
  render_count?: number;
  path: string;
  broken?: boolean;
}

export interface ProjectsListResponse {
  root: string;
  projects: ProjectSummary[];
}

// ─── Ask Cadence ──────────────────────────────────────────────────────────

export interface CadenceTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ProposedAction {
  type: string;
  summary: string;
  params: Record<string, unknown>;
}

export interface AudioEvent {
  start: number;
  end: number;
  kind: string;
  confidence: number;
}

export interface AudioEventBundle {
  events: AudioEvent[];
  source_duration: number;
  model: string;
  schema_version: number;
}

export interface CadenceQueryResponse {
  text: string;
  actions: ProposedAction[];
  input_tokens: number;
  output_tokens: number;
}

export interface AudioPeaks {
  peaks: number[];
  duration: number;
  sample_rate: number;
  bins: number;
}

export interface ThumbnailSprite {
  url: string;
  count: number;
  thumb_width: number;
  thumb_height: number;
  sprite_width: number;
  sprite_height: number;
  source_duration: number;
}

export interface ProbeResponse {
  source: SourceProbe;
  paths: CanonicalPaths;
}

// Stage outputs (what the job.result has on success)
export interface AnalyzeResult {
  analysis_path: string;
}
export interface ClassifyResult {
  classified_path: string;
}
export interface RenderResult {
  rendered_path: string;
  size_bytes: number;
}

export interface PlanSummary {
  source_duration: number;
  output_duration: number;
  keeps_count: number;
  cuts_count: number;
}

export interface PlanResponse {
  plan: {
    source_duration: number;
    output_duration: number;
    keeps: unknown[];
    cuts: unknown[];
  };
  plan_path: string;
}

export interface JobHandle {
  job_id: string;
}

export type JobStatus = "pending" | "running" | "done" | "error";

export interface JobStatusResponse {
  id: string;
  kind: string;
  status: JobStatus;
  progress: number;
  message: string;
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface JobEvent {
  progress?: number;
  message?: string;
  _terminal?: boolean;
  status?: "done" | "error";
}
