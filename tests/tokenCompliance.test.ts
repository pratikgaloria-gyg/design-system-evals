import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenCompliance } from "../scorers/tokenCompliance.js";
import { parseManifest } from "../scorers/tokenManifest.js";
import manifestJson from "../scorers/tokens.manifest.json" with { type: "json" };

const manifest = parseManifest(manifestJson);
const run = (html: string) => tokenCompliance({ output: { rendered_html: html } }, manifest);

test("fully tokenised markup scores 1", () => {
  const r = run(`<style>.card { background: var(--background-primary); padding: var(--spacing-2x) var(--spacing-1x); color: var(--label-primary); }</style>`);
  assert.equal(r.score, 1);
  assert.deepEqual(r.metadata.offenders, []);
});

test("fully hard-coded markup scores 0; offenders carry selector, property, literal and a token suggestion", () => {
  const r = run(`<style>.card { color: #333; padding: 16px; }</style>`);
  assert.equal(r.score, 0);
  assert.deepEqual(r.metadata.offenders.map((o) => [o.selector, o.property, o.value, o.suggestion]), [
    [".card", "color", "#333", undefined],
    [".card", "padding", "16px", "var(--spacing-2x)"],
  ]);
});

test("mixed markup: share of compliant values, per-category counts", () => {
  const r = run(`<style>.a { color: var(--label-primary); background: #fff; margin: 0 var(--spacing-1x) 12px; }</style>`);
  assert.equal(r.score, 0.5);
  assert.equal(r.metadata.counts.color.score, 0.5);
  assert.equal(r.metadata.counts.spacing.score, 0.5);
});

test("fallback: var() with a hard-coded fallback is compliant and flagged separately", () => {
  const r = run(`<div style="box-shadow: var(--effect-elevation-sm, 0 1px 2px rgba(0,0,0,.2))"></div>`);
  assert.equal(r.score, 1);
  assert.equal(r.metadata.fallbacks[0].token, "--effect-elevation-sm");
});

test("var() missing from the manifest is an offender", () => {
  const r = run(`<style>.a { color: var(--palette-grey-200); }</style>`);
  assert.equal(r.score, 0);
  assert.equal(r.metadata.offenders[0].reason, "unknown-token");
});
