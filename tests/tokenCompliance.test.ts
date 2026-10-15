import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tokenCompliance, type TokenList } from "../scorers/tokenCompliance.js";

const tokens = JSON.parse(readFileSync(new URL("./fixtures/tokens.json", import.meta.url), "utf8")) as TokenList;
const run = (html: string, t: TokenList | null = tokens) => tokenCompliance({ output: { rendered_html: html } }, t ?? undefined);

test("fully tokenised markup scores 1", () => {
  const r = run(`<style>.card { background: var(--background-primary); padding: var(--spacing-16) var(--spacing-8); }</style>
    <h2 class="t-heading-md" style="color: var(--text-primary)">Hi</h2>`);
  assert.equal(r.score, 1);
  assert.deepEqual(r.metadata.offenders, []);
  assert.equal(r.metadata.counts.color.compliant, 2);
  assert.equal(r.metadata.counts.spacing.compliant, 2);
  assert.equal(r.metadata.counts.type.compliant, 1);
  assert.equal(r.metadata.token_list_version, "test-1");
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
  const r = run(`<style>.a { color: var(--text-primary); background: #fff; margin: 0 var(--spacing-8) 12px; }</style>`);
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
