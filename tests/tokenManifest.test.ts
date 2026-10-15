import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeColor, normalizeLength, parseManifest } from "../scorers/tokenManifest.js";

test("normalizeColor: hex, rgb() and rgba() spellings of one colour compare equal", () => {
  assert.equal(normalizeColor("#FFF"), "#ffffff");
  assert.equal(normalizeColor("rgb(255 255 255)"), "#ffffff");
  assert.equal(normalizeColor("rgba(255, 255, 255, 1)"), "#ffffff");
  assert.equal(normalizeColor("rgb(2 2 38 / 10%)"), normalizeColor("rgba(2,2,38,.1)"));
  assert.equal(normalizeColor("rgba(2, 2, 38, 0.1)"), "rgba(2,2,38,0.1)");
});

test("normalizeLength: rem at 16px, px untouched", () => {
  assert.equal(normalizeLength("0.5rem"), "8px");
  assert.equal(normalizeLength("8px"), "8px");
  assert.equal(normalizeLength("auto"), "auto");
});

test("parseManifest rejects a malformed manifest and defaults styles to []", () => {
  assert.throws(() => parseManifest({ version: "1", tokens: [] }));
  assert.deepEqual(parseManifest({ version: "1", source: "s", tokens: [] }).styles, []);
});
