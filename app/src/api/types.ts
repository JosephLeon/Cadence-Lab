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

export interface ProbeResponse {
  source: SourceProbe;
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
