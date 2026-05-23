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
