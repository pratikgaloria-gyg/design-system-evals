import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalize, toBraintrustEvent, validate } from "../src/trace.js";
import { extractTraceJson, extractTraceJsonFromStorage } from "../src/confluence.js";
import { renderPage } from "../src/renderPage.js";

const load = () => JSON.parse(readFileSync(new URL("./fixtures/traveler-onboarding-carousel.json", import.meta.url), "utf8"));
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("legacy v0.3 fields are renamed", () => {
  const t = normalize(load());
  assert.ok(t.history.every((h) => "self_assessed_compliant" in h && !("compliant" in h)));
  assert.equal(t.efficiency.turn_first_self_assessed_compliant, 2);
  assert.equal(t.status, "closed");
});

test("fixture validates after normalize, not before", () => {
  assert.deepEqual(validate(normalize(load())), []);
  assert.ok(validate(load()).length > 0);
});

test("validator catches wrong types and enums", () => {
  const t = normalize(load()) as any;
  t.timestamp_source = "guessed";
  t.history[0].turn = "one";
  const errs = validate(t);
  assert.ok(errs.some((e) => e.startsWith("timestamp_source")));
  assert.ok(errs.some((e) => e.startsWith("history/0/turn")));
});

test("event shape has no scores and carries counts", () => {
  const t = normalize(load());
  const ev = toBraintrustEvent(t, t.session_id, { kind: "test" });
  assert.equal(ev.id, "traveler-onboarding-carousel-session");
  assert.ok(!("scores" in ev));
  assert.equal(ev.metadata.deviations_aware, 3);
  assert.equal(ev.metadata.user_corrections_required, 3);
  assert.deepEqual(ev.metadata.components_used, ["CButton"]);
});

test("extract picks the last json code block that has a session_id", () => {
  const t = normalize(load());
  const adf = {
    type: "doc",
    content: [
      { type: "codeBlock", attrs: { language: "json" }, content: [{ type: "text", text: '{"not": "a trace"}' }] },
      { type: "codeBlock", attrs: { language: "python" }, content: [{ type: "text", text: "print(1)" }] },
      { type: "expand", content: [{ type: "codeBlock", attrs: { language: "json" }, content: [{ type: "text", text: JSON.stringify(t) }] }] },
    ],
  };
  assert.deepEqual(extractTraceJson(adf), t);
  assert.equal(extractTraceJson({ type: "doc", content: [] }), null);
});

test("extract from storage format", () => {
  const t = normalize(load());
  const storage =
    '<h2>Trace</h2><ac:structured-macro ac:name="code" ac:schema-version="1" ac:macro-id="x">' +
    '<ac:parameter ac:name="language">json</ac:parameter><ac:parameter ac:name="wrap">false</ac:parameter>' +
    `<ac:plain-text-body><![CDATA[${JSON.stringify(t)}]]></ac:plain-text-body></ac:structured-macro>`;
  assert.deepEqual(extractTraceJsonFromStorage(storage), t);
});

test("rendered page embeds identical JSON as the last block", () => {
  const html = renderPage(load());
  const start = html.lastIndexOf('<code class="language-json">') + '<code class="language-json">'.length;
  const end = html.indexOf("</code></pre>", start);
  assert.deepEqual(JSON.parse(unescape(html.slice(start, end))), normalize(load()));
  assert.ok(html.includes("<h2>Turn history</h2>"));
  assert.ok(html.endsWith("</code></pre>"));
});
