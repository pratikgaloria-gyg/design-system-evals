import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { a11yHygiene, type A11yCheckId, type A11yOptions } from "../scorers/a11yHygiene.js";
import { parseHtml, selectorFor, snippetFor, textContent, walk } from "../scorers/html.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/a11y/${name}`, import.meta.url), "utf8");
const run = (html: string, opts?: A11yOptions, accessibility?: Record<string, unknown>) =>
  a11yHygiene({ output: { rendered_html: html, ...(accessibility && { accessibility }) } }, opts);

/** Assert a check is applicable and has exactly `failed` failures out of `inspected`. */
function expectCheck(html: string, id: A11yCheckId, inspected: number, failed: number, opts?: A11yOptions) {
  const r = run(html, opts);
  const c = r.metadata.checks[id];
  assert.equal(c.inspected, inspected, `${id} inspected`);
  assert.equal(c.failed, failed, `${id} failed`);
  assert.equal(r.metadata.failures[id]?.length ?? 0, failed);
  return r;
}

// --- img_alt -------------------------------------------------------------------------------
test("img_alt: passes with alt, or empty alt + aria-hidden / role=presentation", () => {
  expectCheck('<img src="a.png" alt="Eiffel Tower">', "img_alt", 1, 0);
  expectCheck('<img src="a.png" alt="" aria-hidden="true">', "img_alt", 1, 0);
  expectCheck('<img src="a.png" alt="" role="presentation">', "img_alt", 1, 0);
  expectCheck('<div aria-hidden="true"><img src="a.png" alt=""></div>', "img_alt", 1, 0); // hidden wrapper
});
test("img_alt: fails on missing alt and on bare empty alt", () => {
  const r = expectCheck('<img src="a.png"><img src="b.png" alt="">', "img_alt", 2, 2);
  assert.match(r.metadata.failures.img_alt![0].reason, /missing alt/);
  assert.match(r.metadata.failures.img_alt![1].reason, /empty alt/);
  assert.match(r.metadata.failures.img_alt![0].snippet, /^<img src="a.png">/);
});

// --- interactive_name ----------------------------------------------------------------------
test("interactive_name: text, aria-label, aria-labelledby, img alt and svg title all name a control", () => {
  const html = `
    <button>Next</button>
    <button aria-label="Close"></button>
    <span id="l">Share</span><button aria-labelledby="l"></button>
    <a href="/x"><img src="i.svg" alt="Home"></a>
    <button><svg><title>Search</title></svg></button>
    <div role="button" tabindex="0">Retry</div>`;
  expectCheck(html, "interactive_name", 6, 0);
});
test("interactive_name: icon-only controls without a name fail; aria-hidden text does not count", () => {
  const html = `
    <button><svg viewBox="0 0 1 1"/></button>
    <a href="/x"><i class="icon"></i></a>
    <button><span aria-hidden="true">x</span></button>
    <a name="anchor">not interactive without href</a>`;
  const r = expectCheck(html, "interactive_name", 3, 3);
  assert.equal(r.metadata.failures.interactive_name![0].selector, "button:nth-of-type(1)");
});
test("interactive_name: aria-hidden controls are not inspected", () => {
  const r = run('<div aria-hidden="true"><button></button></div>');
  assert.equal(r.metadata.checks.interactive_name.applicable, false);
});

// --- interactive_focusable -----------------------------------------------------------------
test("interactive_focusable: native controls and tabindex'd role elements pass", () => {
  const html = `<div role="button" tabindex="0">Go</div><div onclick="x()" tabindex="-1">Go</div><button>Native</button>`;
  expectCheck(html, "interactive_focusable", 2, 0);
});
test("interactive_focusable: onclick / role without tabindex fail, including <a> without href", () => {
  const html = `<div onclick="x()">Go</div><span role="tab">Tab</span><a onclick="x()">Link</a>`;
  const r = expectCheck(html, "interactive_focusable", 3, 3);
  assert.match(r.metadata.failures.interactive_focusable![0].reason, /onclick on <div>/);
  assert.match(r.metadata.failures.interactive_focusable![1].reason, /role="tab"/);
});

// --- aria_refs -----------------------------------------------------------------------------
test("aria_refs: resolving labelledby / describedby / controls pass (space-separated lists too)", () => {
  const html = `<h2 id="h">T</h2><p id="d">D</p><div id="panel"></div>
    <section aria-labelledby="h d" aria-describedby="d"></section><button aria-controls="panel">Open</button>`;
  expectCheck(html, "aria_refs", 4, 0);
});
test("aria_refs: dangling references fail individually", () => {
  const html = `<h2 id="h">T</h2><section aria-labelledby="h missing" aria-describedby="nope"></section><button aria-controls="gone">Open</button>`;
  const r = expectCheck(html, "aria_refs", 4, 3);
  assert.match(r.metadata.failures.aria_refs![0].reason, /aria-labelledby="missing"/);
});

// --- form_labels ---------------------------------------------------------------------------
test("form_labels: label[for], wrapping label, aria-label and aria-labelledby pass", () => {
  const html = `
    <label for="a">Email</label><input id="a" type="email">
    <label>Name <input type="text"></label>
    <input type="search" aria-label="Search">
    <span id="t">Country</span><select aria-labelledby="t"><option>DE</option></select>
    <input type="hidden" name="csrf"><input type="submit" value="Send">`;
  expectCheck(html, "form_labels", 4, 0);
});
test("form_labels: placeholder-only and orphaned label[for] fail", () => {
  const html = `<input type="text" placeholder="Search"><label for="zzz">Gone</label><textarea id="q"></textarea>`;
  expectCheck(html, "form_labels", 2, 2);
});

// --- heading_order -------------------------------------------------------------------------
test("heading_order: sequential and descending levels pass; first heading may start anywhere", () => {
  expectCheck("<h2>A</h2><h3>B</h3><h3>C</h3><h2>D</h2><h4 hidden>skip but hidden</h4>", "heading_order", 3, 0);
});
test("heading_order: h1 -> h3 fails", () => {
  const r = expectCheck("<h1>A</h1><h3>B</h3>", "heading_order", 1, 1);
  assert.match(r.metadata.failures.heading_order![0].reason, /h1 followed by h3/);
});
test("heading_order: a single heading is not applicable", () => {
  assert.equal(run("<h2>Only</h2>").metadata.checks.heading_order.applicable, false);
});

// --- landmarks -----------------------------------------------------------------------------
test("landmarks: not applicable for components (default)", () => {
  assert.equal(run("<div><button>Go</button></div>").metadata.checks.landmarks.applicable, false);
});
test("landmarks (page): <main>, role=main, or a named region pass", () => {
  for (const html of ["<main><p>x</p></main>", '<div role="main"></div>', '<section aria-label="Bookings"></section>']) {
    expectCheck(html, "landmarks", 1, 0, { outputKind: "page" });
  }
});
test("landmarks (page): bare divs and unnamed region fail", () => {
  expectCheck("<div><section><p>x</p></section></div>", "landmarks", 1, 1, { outputKind: "page" });
  expectCheck('<div role="region"></div>', "landmarks", 1, 1, { outputKind: "page" });
});

// --- scoring -------------------------------------------------------------------------------
test("carousel session (labelled dots, aria-live, aria-hidden illustration) scores high", () => {
  const r = run(fixture("onboarding-carousel.dc.html"));
  assert.equal(r.name, "a11y_hygiene");
  assert.equal(r.score, 1);
  assert.deepEqual(r.metadata.failures, {});
  assert.equal(r.metadata.checks.interactive_name.inspected, 5);
  assert.equal(r.metadata.checks.img_alt.inspected, 1);
});
test("fixture with unlabeled icon buttons scores low", () => {
  const r = run(fixture("unlabeled-icon-buttons.dc.html"));
  assert.ok(r.score !== null && r.score < 0.3, `score ${r.score}`);
  const f = r.metadata.failures;
  assert.equal(f.interactive_name?.length, 3); // two icon-only buttons + a link whose only content is an alt-less img
  assert.equal(f.img_alt?.length, 2);
  assert.equal(f.interactive_focusable?.length, 2); // div[onclick], span[role=button]
  assert.ok(f.form_labels && f.heading_order && f.aria_refs);
});
test("score is the unweighted mean of per-category rates", () => {
  // img_alt 1/2 = 0.5, interactive_name 1/1 = 1  ->  0.75
  const r = run('<img src="a" alt="ok"><img src="b"><button>Go</button>');
  assert.equal(r.score, 0.75);
});
test("a category's weight does not depend on how many elements it has", () => {
  const many = "<button>A</button>".repeat(50);
  const r = run(`${many}<img src="x">`); // names 50/50 = 1, img_alt 0/1 = 0  ->  0.5
  assert.equal(r.score, 0.5);
});

test("self-reported flags go to metadata and never change the score", () => {
  const html = '<img src="x"><button></button>';
  const none = run(html);
  const claimed = run(html, undefined, { contrast_checked: true, keyboard_nav_checked: true, aria_notes: "all good" });
  assert.equal(claimed.score, none.score);
  assert.deepEqual(claimed.metadata.self_reported, { contrast_checked: true, keyboard_nav_checked: true, aria_notes: "all good" });
  assert.deepEqual(none.metadata.self_reported, { contrast_checked: null, keyboard_nav_checked: null, aria_notes: null });
});

test("missing or empty rendered_html returns null, not 0", () => {
  for (const output of [undefined, {}, { rendered_html: "" }, { rendered_html: 42 }]) {
    const r = a11yHygiene({ output });
    assert.equal(r.score, null);
    assert.equal(r.metadata.skipped, "no rendered_html");
  }
});
test("markup with nothing to inspect returns null, not a free 1", () => {
  const r = run("<div><p>Just text</p></div>");
  assert.equal(r.score, null);
  assert.match(r.metadata.skipped!, /no applicable checks/);
});

test("failures are capped per check and the overflow is counted", () => {
  const r = run("<img src='x'>".repeat(30), { maxFailuresPerCheck: 5 });
  assert.equal(r.metadata.failures.img_alt!.length, 5);
  assert.equal(r.metadata.failures_truncated.img_alt, 25);
  assert.equal(r.metadata.checks.img_alt.failed, 30);
});

test("metadata reports elements inspected and script presence", () => {
  const r = run('<div><button>Go</button><script>render()</script></div>');
  assert.equal(r.metadata.elements_inspected, 6); // html, head, body (implied by parse5) + div, button, script
  assert.equal(r.metadata.script_elements, 1);
});

// --- parse5 adapter ------------------------------------------------------------------------
test("adapter: tree, attributes, entities and snippets come through parse5 correctly", () => {
  const src = `<!doctype html><!-- <button> --><p>one<p>a &amp; b<ul><li>x<li>y</ul><img alt="a > b" src=x><script>if (a < b) {}</script>`;
  const root = parseHtml(src);
  const els = [...walk(root)];
  assert.deepEqual(els.map((e) => e.tag), ["html", "head", "body", "p", "p", "ul", "li", "li", "img", "script"]);
  const img = els.find((e) => e.tag === "img")!;
  assert.equal(img.attrs.alt, "a > b");
  assert.equal(img.parent?.tag, "body");
  assert.equal(snippetFor(img, src), '<img alt="a > b" src=x>');
  assert.equal(selectorFor(img), "img");
  assert.equal(textContent(els.filter((e) => e.tag === "p")[1]), "a & b");
  assert.equal(textContent(els.find((e) => e.tag === "ul")!), "x y");
});
test("adapter: <template> content is inert and not inspected", () => {
  assert.equal(run("<template><button></button></template>").metadata.checks.interactive_name.applicable, false);
});
test("adapter: malformed input does not throw", () => {
  assert.doesNotThrow(() => parseHtml('<div class="a" <button'));
  assert.doesNotThrow(() => parseHtml("<div><span></div></span></p>"));
});
