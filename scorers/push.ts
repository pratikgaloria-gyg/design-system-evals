/**
 * Registers the code scorers with the Braintrust project. Push with: npm run push:scorers
 *
 * Env (same as the ingest job, from .env): BRAINTRUST_API_KEY, BRAINTRUST_PROJECT_ID, and BRAINTRUST_API_URL (EU: https://api-eu.braintrust.dev).
 * Re-pushing an existing slug needs --if-exists replace (set in the npm script); the default is to error.
 * Attach scorers to logs with an online scoring rule (Settings > Automations), see UDS-526.
 */
import braintrust from "braintrust";
import { z } from "zod";
import { a11yHygiene } from "./a11yHygiene.js";

// This module is evaluated twice: locally at push time (BRAINTRUST_PROJECT_ID set by `npm run push:scorers`,
// which refuses to run without it), and again inside Braintrust's runtime whenever the scorer runs, where
// that variable does not exist. So never throw here: the runtime only needs the handler, not the project binding.
const project = braintrust.projects.create({ id: process.env.BRAINTRUST_PROJECT_ID ?? "runtime-unused" });

// Scorers read the ingested event's `output` (output.rendered_html from UDS-525).
project.scorers.create({
  name: "a11y_hygiene",
  slug: "a11y-hygiene",
  description: "Static accessibility checks on output.rendered_html (UDS-530). Null when there is nothing to score.",
  parameters: z.object({ output: z.any() }),
  handler: async ({ output }) => a11yHygiene({ output }),
});
