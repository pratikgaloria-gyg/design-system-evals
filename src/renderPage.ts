/**
 * Render a trace as a Confluence page body (Atlassian HTML format).
 * The readable sections are DERIVED from the JSON. The JSON code block at the end is the
 * source of truth and the only thing `ingest run` parses. Never hand-edit the readable part.
 */
import type { Trace } from "./types.js";
import { awareDeviations, normalize } from "./trace.js";

const STATUS_COLOR: Record<string, string> = { closed: "green", in_progress: "blue", abandoned: "yellow" };
const CONF_COLOR: Record<string, string> = { aware: "yellow", unsure: "neutral" };

export const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const lozenge = (text: string, color: string) => `<span data-type="status" data-color="${color}">${esc(text)}</span>`;
const yesNo = (v: boolean) => (v ? lozenge("checked", "green") : lozenge("not checked", "red"));
const ul = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "<p><em>none</em></p>");
const table = (headers: string[], rows: string[][]) =>
  rows.length
    ? `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`
    : "<p><em>none</em></p>";

export function renderPage(input: unknown): string {
  const t: Trace = normalize(input);
  const { design_system: ds, coverage: cov, accessibility: a11y, artifacts: art, efficiency: eff } = t;
  const aware = awareDeviations(t);

  const header = table(["Field", "Value"], [
    ["Session ID", `<code>${esc(t.session_id)}</code>`],
    ["Project", esc(t.project)],
    ["Status", lozenge(t.status, STATUS_COLOR[t.status] ?? "neutral")],
    ["Timestamp", `${esc(t.timestamp ?? "unknown")} <em>(${esc(t.timestamp_source)})</em>`],
    ["Skill version", `<code>${esc(t.skill_version)}</code>`],
    ["Turns / corrections", `${eff.total_turns} turns, ${eff.user_corrections_required} user corrections, first self-assessed compliant at turn ${eff.turn_first_self_assessed_compliant}`],
    ["Self-assessed uncertainty", esc(t.self_assessed_uncertainty ?? "")],
    ["Deviations", `${ds.deviations.length} total, ${aware} the model was aware of`],
  ]);

  const note =
    '<div data-type="panel-note"><p><strong>How to read this page.</strong> Everything above the JSON block is rendered ' +
    "from the JSON by <code>design-system-evals/src/renderPage.ts</code>. The JSON is the record; " +
    "the ingest job only parses the JSON code block. <code>self_assessed_compliant</code> is the model's own belief per turn, " +
    "not a verified compliance score.</p></div>";

  const jsonBlock = `<pre data-wrap="false"><code class="language-json">${esc(JSON.stringify(t, null, 2))}</code></pre>`;

  return [
    header,
    note,
    "<h2>Brief</h2>",
    `<p>${esc(t.brief.summary)}</p><p><em>Source: ${esc(t.brief.source)}</em></p>`,
    "<h2>Design system</h2>",
    "<h3>Compass components used</h3>",
    table(["Component", "Variant", "Source"], ds.components_used.map((c) => [esc(c.name), esc(c.variant), esc(c.source)])),
    "<h3>Tokens used</h3>", ul(ds.tokens_used),
    "<h3>Custom or invented</h3>",
    table(["Custom / invented", "Reason"], ds.components_invented_or_custom.map((c) => [esc(c.name), esc(c.reason)])),
    "<h3>Deviations from Compass</h3>",
    table(["What deviated", "Why", "Confidence"], ds.deviations.map((d) => [esc(d.what), esc(d.why), lozenge(d.confidence ?? "?", CONF_COLOR[d.confidence ?? ""] ?? "neutral")])),
    "<h2>Coverage</h2>",
    "<h3>Scenarios considered</h3>", ul(cov.scenarios_considered),
    "<h3>Explicitly skipped</h3>", ul(cov.scenarios_explicitly_skipped),
    "<h2>Accessibility</h2>",
    table(["Check", "Result"], [["Contrast", yesNo(a11y.contrast_checked)], ["Keyboard navigation", yesNo(a11y.keyboard_nav_checked)]]),
    `<p>${esc(a11y.aria_notes)}</p>`,
    "<h2>Artifacts</h2>",
    ul(art.files_touched),
    `<p><strong>Output:</strong> ${esc(art.output_ref)}</p>`,
    "<h2>Turn history</h2>",
    table(["Turn", "Change", "Self-assessed compliant"], t.history.map((h) => [String(h.turn), esc(h.change), h.self_assessed_compliant ? lozenge("yes", "green") : lozenge("no", "red")])),
    "<h2>Trace (JSON, source of truth)</h2>",
    jsonBlock,
  ].join("");
}
