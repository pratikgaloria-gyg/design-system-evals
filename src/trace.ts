/** Trace normalisation and mapping to a Braintrust log event. */
import type { BraintrustEvent, Trace } from "./types.js";
import type { OutputCapture } from "./output.js";
import { SCHEMA_VERSION } from "./schema.js";
export { validate } from "./schema.js";

// v0.3 -> v0.4 renames (UDS-465 finding: the boolean is a self-assessment, not a score)
const LEGACY_TURN: Record<string, string> = { compliant: "self_assessed_compliant" };
const LEGACY_EFF: Record<string, string> = { turn_first_compliant: "turn_first_self_assessed_compliant" };

function rename(obj: Record<string, unknown>, map: Record<string, string>) {
  for (const [from, to] of Object.entries(map)) {
    if (from in obj && !(to in obj)) {
      obj[to] = obj[from];
      delete obj[from];
    }
  }
}

/** Deep-copy, map legacy field names to v0.4, fill defaults. Does not validate. */
export function normalize(input: unknown): Trace {
  const t = structuredClone(input) as Record<string, unknown>;
  for (const turn of (t.history as Record<string, unknown>[] | undefined) ?? []) rename(turn, LEGACY_TURN);
  t.efficiency ??= {};
  rename(t.efficiency as Record<string, unknown>, LEGACY_EFF);
  t.status ??= "closed";
  t.timestamp ??= null;
  t.timestamp_source ??= "unknown";
  return t as unknown as Trace;
}

export function awareDeviations(t: Trace): number {
  return t.design_system.deviations.filter((d) => d.confidence === "aware").length;
}

/**
 * Map a normalised trace to a Braintrust `project_logs` insert event.
 * No `scores` on purpose: self_assessed_compliant must never be read as the compliance
 * score (UDS-465). Scoring happens in Braintrust once UDS-467 lands.
 */
export function toBraintrustEvent(
  t: Trace, eventId: string, source: Record<string, unknown> = {}, capture?: OutputCapture,
): BraintrustEvent {
  const eff = t.efficiency;
  return {
    id: eventId,
    input: t.brief,
    output: {
      design_system: t.design_system,
      coverage: t.coverage,
      accessibility: t.accessibility,
      artifacts: t.artifacts,
      history: t.history,
      // Rendered output (UDS-525), present only when output files were fetched from Drive.
      ...(capture?.rendered_html !== undefined && { rendered_html: capture.rendered_html }),
      ...(capture && capture.assets.length > 0 && { assets: capture.assets }),
      ...(capture && capture.skipped.length > 0 && { output_skipped: capture.skipped }),
    },
    metadata: {
      schema_version: SCHEMA_VERSION,
      skill_version: t.skill_version,
      session_id: t.session_id,
      project: t.project,
      status: t.status,
      timestamp: t.timestamp,
      timestamp_source: t.timestamp_source,
      self_assessed_uncertainty: t.self_assessed_uncertainty ?? null,
      total_turns: eff.total_turns,
      turn_first_self_assessed_compliant: eff.turn_first_self_assessed_compliant,
      user_corrections_required: eff.user_corrections_required,
      deviations_total: t.design_system.deviations.length,
      deviations_aware: awareDeviations(t),
      components_used: [...new Set(t.design_system.components_used.map((c) => c.name))].sort(),
      has_rendered_html: capture?.rendered_html !== undefined,
      source,
    },
    tags: ["self-reported", `skill:${t.skill_version}`, `status:${t.status}`],
    span_attributes: { name: t.project || t.session_id, type: "task" },
  };
}
