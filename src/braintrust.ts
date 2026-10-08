/** Minimal Braintrust REST client (EU data plane by default). */
import type { BraintrustEvent } from "./types.js";

export const DEFAULT_API_URL = "https://api-eu.braintrust.dev";

export class BraintrustClient {
  private apiUrl: string;
  private headers: Record<string, string>;
  readonly projectId: string;

  constructor(opts: { apiKey?: string; apiUrl?: string; projectId?: string } = {}) {
    const apiKey = opts.apiKey ?? process.env.BRAINTRUST_API_KEY;
    if (!apiKey) throw new Error("Missing env var BRAINTRUST_API_KEY");
    this.apiUrl = (opts.apiUrl ?? process.env.BRAINTRUST_API_URL ?? DEFAULT_API_URL).replace(/\/$/, "");
    this.projectId = opts.projectId ?? process.env.BRAINTRUST_PROJECT_ID ?? "";
    if (!this.projectId) throw new Error("Missing env var BRAINTRUST_PROJECT_ID");
    this.headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  }

  /** Sanity check that the key can see the project. */
  async project(): Promise<{ id: string; name: string }> {
    const r = await fetch(`${this.apiUrl}/v1/project/${this.projectId}`, { headers: this.headers });
    if (!r.ok) throw new Error(`Braintrust ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as { id: string; name: string };
  }

  /** Insert events into project logs. Same `id` twice = overwrite (upsert). */
  async insertLogs(events: BraintrustEvent[]): Promise<{ row_ids: string[] }> {
    const r = await fetch(`${this.apiUrl}/v1/project_logs/${this.projectId}/insert`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ events }),
    });
    if (!r.ok) throw new Error(`Braintrust insert failed ${r.status}: ${(await r.text()).slice(0, 500)}`);
    return (await r.json()) as { row_ids: string[] };
  }
}
