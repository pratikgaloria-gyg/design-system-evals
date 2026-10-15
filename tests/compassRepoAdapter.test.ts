import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompassManifest } from "../adapters/compassRepo.js";
import { parseManifest } from "../scorers/tokenManifest.js";

const root = new URL("./fixtures/compass-repo", import.meta.url).pathname;
const manifest = buildCompassManifest(root, { sha: "abcdef0123456789" });
const token = (name: string) => manifest.tokens.find((t) => t.name === name);

test("manifest is valid and stamped with the source ref", () => {
  parseManifest(manifest);
  assert.equal(manifest.version, "compass-abcdef0");
  assert.equal(manifest.source, "compass-repo@abcdef0123456789");
});

test("colour tokens: variants merged, palette refs and rgba() resolved", () => {
  assert.deepEqual(token("--label-primary")?.values?.sort(), ["#1a2b49", "#ffffff", "rgb(2 2 38 / 100%)", "rgb(255 255 255 / 100%)"].sort());
  assert.ok(token("--interactive-tertiary-hovered")?.values?.includes("rgba(220,223,228,0.5)"));
  assert.equal(token("--filter-default")?.category, "color"); // exists only in a variant map
});

test("spacing, shadow and font-family custom properties, with interpolation resolved", () => {
  assert.deepEqual(token("--spacing-1x"), { name: "--spacing-1x", category: "spacing", tier: "semantic", values: ["8px"] });
  assert.equal(token("--spacing-none")?.values?.[0], "0");
  assert.equal(token("--effect-elevation-xs")?.category, "shadow");
  assert.equal(token("--effect-elevation-sm")?.values?.[0], "0px 1px 2px 0px rgb(2 2 38 / 10%), 0px 1px 3px 0px rgb(2 2 38 / 10%)");
  assert.equal(token("--font-family")?.category, "type");
  assert.equal(token("--palette-grey-200"), undefined); // palette is SCSS-only in compass
});

test("type styles resolved from the font-style-new mixin", () => {
  assert.deepEqual(manifest.styles.map((s) => [s.name, s.match]), [
    ["heading-md", { "font-size": "28px", "line-height": "1.2", "font-weight": "750" }],
    ["text-regular-sm", { "font-size": "14px", "line-height": "1.5", "font-weight": "425" }],
    ["text-link-regular-sm", { "font-size": "14px", "line-height": "1.5", "font-weight": "425" }], // alias via @include
  ]);
});
