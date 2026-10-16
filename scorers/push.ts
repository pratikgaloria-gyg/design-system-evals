/**
 * Registers the code scorers with the Braintrust project. Push with: npm run push:scorers -- --name <scorer> (or --all)
 * Only scorers named in PUSH_SCORERS (set by scripts/push-scorers.sh) are registered, so unchanged scorers are not re-uploaded.
 *
 * Env (same as the ingest job, from .env): BRAINTRUST_API_KEY, BRAINTRUST_PROJECT_ID, and BRAINTRUST_API_URL (EU: https://api-eu.braintrust.dev).
 * Re-pushing an existing slug needs --if-exists replace (set in the npm script); the default is to error.
 * Attach scorers to logs with an online scoring rule (Settings > Automations), see UDS-526.
 */
import braintrust from "braintrust";
import { z } from "zod";
import { a11yHygiene } from "./a11yHygiene.js";
import { tokenCompliance } from "./tokenCompliance.js";
import { parseManifest } from "./tokenManifest.js";
import manifestJson from "./tokens.manifest.json" with { type: "json" };

// This module is evaluated twice: locally at push time (BRAINTRUST_PROJECT_ID set by `npm run push:scorers`,
// which refuses to run without it), and again inside Braintrust's runtime whenever the scorer runs, where
// that variable does not exist. So never throw on missing env here: the runtime only needs the handler, not the project binding.
// (The unknown-name check below only fires when PUSH_SCORERS is set, which only the push script does.)
const KNOWN = ["a11y_hygiene", "token_compliance"];
const only = process.env.PUSH_SCORERS ? new Set(process.env.PUSH_SCORERS.split(",").map((n) => n.trim()).filter(Boolean)) : null;
for (const n of only ?? []) if (!KNOWN.includes(n)) throw new Error(`Unknown scorer "${n}". Known: ${KNOWN.join(", ")}`);
const enabled = (name: string) => !only || only.has(name);

const project = braintrust.projects.create({ id: process.env.BRAINTRUST_PROJECT_ID ?? "runtime-unused" });

// Scorers read the ingested event's `output` (output.rendered_html from UDS-525).
if (enabled("a11y_hygiene")) project.scorers.create({
  name: "a11y_hygiene",
  slug: "a11y-hygiene",
  description: "Static accessibility checks on output.rendered_html (UDS-530). Null when there is nothing to score.",
  parameters: z.object({ output: z.any() }),
  handler: async ({ output }) => a11yHygiene({ output }),
});

// TODO(UDS-528): scorers/tokens.manifest.json is a hand-written EXAMPLE. Replace it with the manifest emitted from the token
// source of truth (see README); this file only reads it at push time. `token_list_version` in each score records which one was used.
const manifest = parseManifest(manifestJson);
if (enabled("token_compliance")) project.scorers.create({
  name: "token_compliance",
  slug: "token-compliance",
  description: "Share of colour, typography and spacing values in inline styles that use Compass tokens (UDS-528). Null when there is nothing to score.",
  parameters: z.object({ output: z.any() }),
  handler: async ({ output }) => tokenCompliance({ output }, manifest),
});
