/** Trace format v0.4 (UDS-465). Keep in sync with schema/trace.schema.json. */
export type TimestampSource = "browser-clock" | "user-provided" | "unknown";
export type Confidence = "aware" | "unsure";
export type SessionStatus = "in_progress" | "closed" | "abandoned";

export interface Trace {
  session_id: string;
  project: string;
  timestamp: string | null;
  timestamp_source: TimestampSource;
  skill_version: string;
  status: SessionStatus;
  brief: { summary: string; source: string };
  design_system: {
    components_used: { name: string; variant?: string; source?: string }[];
    tokens_used: string[];
    components_invented_or_custom: { name: string; reason?: string }[];
    deviations: { what: string; why?: string; confidence?: Confidence }[];
  };
  coverage: { scenarios_considered: string[]; scenarios_explicitly_skipped: string[] };
  accessibility: { contrast_checked: boolean; keyboard_nav_checked: boolean; aria_notes: string };
  artifacts: { files_touched: string[]; output_ref: string };
  self_assessed_uncertainty?: "low" | "medium" | "high";
  history: { turn: number; change: string; self_assessed_compliant: boolean }[];
  efficiency: { total_turns: number; turn_first_self_assessed_compliant: number | null; user_corrections_required: number };
  [extra: string]: unknown;
}

/** Shape of one event for POST /v1/project_logs/{project_id}/insert */
export interface BraintrustEvent {
  id: string;
  input: unknown;
  output: unknown;
  metadata: Record<string, unknown>;
  tags: string[];
  span_attributes: { name: string; type: string };
}
