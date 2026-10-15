import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tokenCompliance } from "../scorers/tokenCompliance.js";
import { parseManifest, type TokenManifest } from "../scorers/tokenManifest.js";

const tokens = parseManifest(JSON.parse(readFileSync(new URL("./fixtures/tokens.json", import.meta.url), "utf8")));
const run = (html: string, t: TokenManifest | null = tokens) => tokenCompliance({ output: { rendered_html: html } }, t ?? undefined);

test("fully tokenised markup scores 1", () => {
  const r = run(`<style>.card { background: var(--background-primary); padding: var(--spacing-2x) var(--spacing-1x); }</style>
    <h2 class="t-heading-md" style="color: var(--text-primary)">Hi</h2>`);
  assert.equal(r.score, 1);
  assert.deepEqual(r.metadata.offenders, []);
  assert.equal(r.metadata.counts.color.compliant, 2);
  assert.equal(r.metadata.counts.spacing.compliant, 2);
  assert.equal(r.metadata.counts.type.compliant, 1);
  assert.equal(r.metadata.token_list_version, "test-1");
  assert.equal(r.metadata.token_list_source, "fixture");
});

test("fully hard-coded markup scores 0, offenders carry selector, property and literal", () => {
  const r = run(`<style>.card { color: #333; padding: 16px; font-size: 14px; font-family: Arial, sans-serif; }</style>`);
  assert.equal(r.score, 0);
  assert.deepEqual(r.metadata.offenders.map((o) => [o.selector, o.property, o.value, o.category]), [
    [".card", "color", "#333", "color"],
    [".card", "padding", "16px", "spacing"],
    [".card", "font-size", "14px", "type"],
    [".card", "font-family", "Arial, sans-serif", "type"],
  ]);
});

test("mixed markup: share of compliant values, per-category counts", () => {
  const r = run(`<style>.a { color: var(--text-primary); background: #fff; margin: 0 var(--spacing-1x) 12px; }</style>`);
  assert.equal(r.metadata.counts.color.score, 0.5);
  assert.equal(r.metadata.counts.spacing.score, 0.5);
  assert.equal(r.score, 0.5); // 2 compliant of 4
  assert.equal(r.metadata.offenders.length, 2);
});

test("fallback: var() with a hard-coded fallback is compliant and flagged separately", () => {
  const r = run(`<div style="box-shadow: var(--shadow-elevation-32, 0 8px 16px rgba(0,0,0,.2))"></div>`);
  assert.equal(r.score, 1);
  assert.deepEqual(r.metadata.offenders, []);
  assert.equal(r.metadata.fallbacks.length, 1);
  assert.equal(r.metadata.fallbacks[0].token, "--shadow-elevation-32");
  assert.match(r.metadata.fallbacks[0].fallback, /^0 8px 16px/);
});

test("var() missing from the token list is an offender; without a token list any var() counts", () => {
  const html = `<style>.a { color: var(--my-own-red); }</style>`;
  const r = run(html);
  assert.equal(r.score, 0);
  assert.equal(r.metadata.offenders[0].reason, "unknown-token");
  assert.equal(run(html, null).score, 1);
  assert.equal(run(html, null).metadata.token_list_version, null);
});

test("@media is descended into; 0, auto and inherit are not counted; unrelated properties ignored", () => {
  const r = run(`<style>@media (min-width: 600px) { .a { margin: 0 auto; padding: 8px; display: flex; width: 320px; font-weight: inherit; } }</style>`);
  assert.equal(r.metadata.counts.spacing.offending, 1);
  assert.equal(r.score, 0);
  assert.equal(r.metadata.offenders.length, 1);
});

test("unknown t-* classes do not count when a type class list is given", () => {
  assert.equal(run(`<p class="t-text-regular-sm t-made-up">x</p>`).metadata.counts.type.compliant, 1);
});

test("offenders suggest the token whose value they repeat", () => {
  const r = run(`<style>.a { padding: 8px 0.5rem 13px; color: #DCDFE4; background: rgba(2, 2, 38, 0.9); font-size: 14px; }</style>`);
  const by = (value: string) => r.metadata.offenders.find((o) => o.value === value)?.suggestion;
  assert.equal(by("8px"), "var(--spacing-1x)");
  assert.equal(by("0.5rem"), "var(--spacing-1x)");
  assert.equal(by("13px"), undefined);
  assert.equal(by("#DCDFE4"), "var(--border-primary) or var(--palette-grey-200)");
  assert.equal(by("rgba(2, 2, 38, 0.9)"), undefined); // full function literal, not "rgba()"
  assert.equal(by("14px"), "font-size of type style text-regular-sm");
});

test("primitive tokens are compliant but flagged", () => {
  const r = run(`<style>.a { background: var(--surface-secondary-missing, #fff); border-color: var(--palette-grey-200); }</style>`);
  assert.deepEqual(r.metadata.primitives, [{ selector: ".a", property: "border-color", token: "--palette-grey-200" }]);
  assert.equal(r.metadata.counts.color.compliant, 1);
  assert.equal(r.metadata.counts.color.offending, 1); // unknown token
});

test("a block that spells out a manifest type style by value is compliant", () => {
  const r = run(`<style>.t { font-size: 28px; line-height: 1.2; font-weight: 750; } .u { font-size: 1.75rem; line-height: 1.2; font-weight: 800; }</style>`);
  assert.deepEqual(r.metadata.value_matches, [{ selector: ".t", style: "heading-md" }]);
  assert.equal(r.metadata.counts.type.compliant, 3);
  assert.equal(r.metadata.counts.type.offending, 3); // .u has the wrong weight, so no style matches
  assert.equal(r.metadata.offenders[0].suggestion, "font-size of type style heading-md");
});

test("with a manifest but no class names, t-* classes do not count; without a manifest they do", () => {
  const noClasses = parseManifest({ ...tokens, styles: tokens.styles.map(({ classNames: _c, ...st }) => st) });
  assert.equal(run(`<p class="t-heading-md">x</p>`, noClasses).metadata.counts.type.compliant, 0);
  assert.equal(run(`<p class="t-heading-md">x</p>`, null).metadata.counts.type.compliant, 1);
});

test("null score when there is nothing to measure or no HTML", () => {
  assert.equal(run("<p>plain</p>").score, null);
  assert.equal(tokenCompliance({ output: {} }, tokens).metadata.skipped, "no rendered_html");
});

test("existing fixture sessions: type classes counted, no inline literals", () => {
  const html = readFileSync(new URL("./fixtures/output/Empty Bookings Card.dc.html", import.meta.url), "utf8");
  const r = run(html);
  assert.equal(r.score, 1);
  assert.equal(r.metadata.counts.type.compliant, 2);
});
