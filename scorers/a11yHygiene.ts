/**
 * Scorer: a11y_hygiene (UDS-530, epic UDS-526).
 *
 * Deterministic accessibility checks that can be made from static markup alone (no browser, no
 * computed styles). Reads `output.rendered_html` from the Braintrust event (UDS-525).
 *
 * Score: mean of per-category pass rates over the categories that apply to this document
 * (each category weighs the same, whatever its number of elements). A category with nothing to
 * inspect is "not applicable" and left out rather than counted as a free pass.
 * `score` is null when nothing could be scored (no HTML, or no category applicable).
 *
 * The trace's self-reported flags (`output.accessibility`) are copied into metadata for later
 * agreement analysis. They NEVER influence the score.
 *
 * Out of scope (needs a renderer): contrast, focus order, screen-reader behaviour, motion.
 * Limitation: only markup present in the captured HTML is seen. Content a script builds at
 * runtime is invisible; `metadata.script_elements` hints when that may matter.
 */
import { type Element, hasAttr, parseHtml, selectorFor, snippetFor, textContent, walk } from "./html.js";

export const A11Y_CHECKS = [
  "img_alt",
  "interactive_name",
  "interactive_focusable",
  "aria_refs",
  "form_labels",
  "heading_order",
  "landmarks",
] as const;
export type A11yCheckId = (typeof A11Y_CHECKS)[number];

export interface A11yOptions {
  /**
   * "component": landmarks check is not applicable (default; most Claude Design output is a card or widget).
   * "page": requires `main` / `[role=main]` / a named region.
   */
  outputKind?: "page" | "component";
  /** Max failing elements listed per check in metadata. */
  maxFailuresPerCheck?: number;
}

export interface A11yFailure { selector: string; snippet: string; reason: string }
export interface A11yCheckResult { applicable: boolean; inspected: number; passed: number; failed: number; score: number | null }
export interface A11yMetadata {
  skipped?: string;
  output_kind: "page" | "component";
  elements_inspected: number;
  script_elements: number;
  checks: Record<A11yCheckId, A11yCheckResult>;
  failures: Partial<Record<A11yCheckId, A11yFailure[]>>;
  failures_truncated: Partial<Record<A11yCheckId, number>>;
  self_reported: { contrast_checked: boolean | null; keyboard_nav_checked: boolean | null; aria_notes: string | null };
}
export interface A11yScore { name: "a11y_hygiene"; score: number | null; metadata: A11yMetadata }

/** Roles that make a generic element interactive. */
const INTERACTIVE_ROLES = new Set([
  "button", "link", "tab", "checkbox", "radio", "switch", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "gridcell",
]);
const NON_FIELD_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);
const BUTTON_INPUT_TYPES = new Set(["submit", "button", "reset"]);

const role = (el: Element) => (el.attrs.role ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
const isHiddenFromAT = (el: Element) => {
  for (let c: Element | null = el; c; c = c.parent) {
    if (c.attrs["aria-hidden"] === "true" || hasAttr(c, "hidden")) return true;
  }
  return false;
};
const inputType = (el: Element) => (el.attrs.type ?? "text").toLowerCase();

/** Native interactive control, or a generic element made interactive by role. */
function isNativeInteractive(el: Element): boolean {
  switch (el.tag) {
    case "button": case "select": case "textarea": case "summary": return true;
    case "a": case "area": return hasAttr(el, "href");
    case "input": return inputType(el) !== "hidden";
    default: return false;
  }
}
const isFormField = (el: Element) =>
  (el.tag === "input" && !NON_FIELD_INPUT_TYPES.has(inputType(el))) || el.tag === "select" || el.tag === "textarea";

export function a11yHygiene(args: { output?: unknown }, options: A11yOptions = {}): A11yScore {
  const outputKind = options.outputKind ?? "component";
  const cap = options.maxFailuresPerCheck ?? 20;
  const out = (args.output ?? {}) as { rendered_html?: unknown; accessibility?: Record<string, unknown> };
  const acc = out.accessibility ?? {};
  const self_reported = {
    contrast_checked: typeof acc.contrast_checked === "boolean" ? acc.contrast_checked : null,
    keyboard_nav_checked: typeof acc.keyboard_nav_checked === "boolean" ? acc.keyboard_nav_checked : null,
    aria_notes: typeof acc.aria_notes === "string" ? acc.aria_notes : null,
  };

  const empty = (): Record<A11yCheckId, A11yCheckResult> =>
    Object.fromEntries(A11Y_CHECKS.map((c) => [c, { applicable: false, inspected: 0, passed: 0, failed: 0, score: null }])) as Record<A11yCheckId, A11yCheckResult>;

  const src = out.rendered_html;
  if (typeof src !== "string" || src.trim() === "") {
    return {
      name: "a11y_hygiene",
      score: null,
      metadata: { skipped: "no rendered_html", output_kind: outputKind, elements_inspected: 0, script_elements: 0, checks: empty(), failures: {}, failures_truncated: {}, self_reported },
    };
  }

  const root = parseHtml(src);
  const all = [...walk(root)];
  const byId = new Map<string, Element>();
  for (const el of all) if (el.attrs.id && !byId.has(el.attrs.id)) byId.set(el.attrs.id, el);

  const checks = empty();
  const failures: A11yMetadata["failures"] = {};
  const truncated: A11yMetadata["failures_truncated"] = {};
  const record = (id: A11yCheckId, el: Element | null, ok: boolean, reason = "") => {
    const r = checks[id];
    r.applicable = true;
    r.inspected++;
    if (ok) { r.passed++; return; }
    r.failed++;
    const list = (failures[id] ??= []);
    if (list.length < cap) list.push({ selector: el ? selectorFor(el) : "(document)", snippet: el ? snippetFor(el, src) : "", reason });
    else truncated[id] = (truncated[id] ?? 0) + 1;
  };

  /** Accessible name from aria-labelledby / aria-label / native sources. Empty string = no name. */
  const labelText = (id: string) => (byId.has(id) ? textContent(byId.get(id)!, { includeImgAlt: true }) : "");
  const forLabels = (el: Element) =>
    el.attrs.id ? all.filter((l) => l.tag === "label" && l.attrs.for === el.attrs.id) : [];
  const wrappingLabel = (el: Element) => { for (let c = el.parent; c; c = c.parent) if (c.tag === "label") return c; return null; };
  const accessibleName = (el: Element): string => {
    const lb = (el.attrs["aria-labelledby"] ?? "").split(/\s+/).filter(Boolean).map(labelText).join(" ").trim();
    if (lb) return lb;
    if ((el.attrs["aria-label"] ?? "").trim()) return el.attrs["aria-label"].trim();
    if (el.tag === "input" && BUTTON_INPUT_TYPES.has(inputType(el)) && (el.attrs.value ?? "").trim()) return el.attrs.value.trim();
    if (el.tag === "input" && inputType(el) === "image" && (el.attrs.alt ?? "").trim()) return el.attrs.alt.trim();
    if (isFormField(el)) {
      const ls = [...forLabels(el), ...(wrappingLabel(el) ? [wrappingLabel(el)!] : [])];
      const t = ls.map((l) => textContent(l, { skipHidden: true, includeImgAlt: true })).join(" ").trim();
      if (t) return t;
    } else {
      const t = textContent(el, { skipHidden: true, includeImgAlt: true });
      if (t) return t;
    }
    return (el.attrs.title ?? "").trim(); // last-resort fallback per accname
  };

  // 1. Images have alt. Empty alt is only fine for decorative images (aria-hidden or presentational role).
  for (const el of all) {
    if (el.tag !== "img") continue;
    if (!hasAttr(el, "alt")) { record("img_alt", el, false, "missing alt"); continue; }
    if (el.attrs.alt.trim() === "") {
      // Decorative: the image itself or any ancestor is aria-hidden, or the image has a presentational role.
      const decorative = isHiddenFromAT(el) || role(el) === "presentation" || role(el) === "none";
      record("img_alt", el, decorative, decorative ? "" : 'empty alt without aria-hidden="true" or role="presentation"');
    } else record("img_alt", el, true);
  }

  // 2. Interactive elements have an accessible name (form fields are covered by form_labels).
  // 3. Click handlers / interactive roles are focusable.
  for (const el of all) {
    if (isHiddenFromAT(el)) continue;
    const r = role(el);
    const native = isNativeInteractive(el);
    const byRole = INTERACTIVE_ROLES.has(r);
    const hasHandler = hasAttr(el, "onclick");
    if (!(native || byRole || hasHandler)) continue;

    if (!isFormField(el)) {
      if (native || byRole) {
        const named = accessibleName(el) !== "";
        record("interactive_name", el, named, named ? "" : "no accessible name (text, aria-label, aria-labelledby, title)");
      }
    }
    // Native controls are focusable by construction; only generic elements can fail here.
    if (!native && (byRole || hasHandler)) {
      const ti = el.attrs.tabindex;
      const focusable = ti !== undefined && ti.trim() !== "" && !Number.isNaN(Number(ti));
      record("interactive_focusable", el, focusable, focusable ? "" : `${r ? `role="${r}"` : "onclick"} on <${el.tag}> without tabindex`);
    }
  }

  // 4. aria-labelledby / aria-describedby / aria-controls (+ aria-owns) resolve to an existing id.
  for (const el of all) {
    for (const attr of ["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns"]) {
      if (!hasAttr(el, attr)) continue;
      for (const ref of el.attrs[attr].split(/\s+/).filter(Boolean)) {
        record("aria_refs", el, byId.has(ref), byId.has(ref) ? "" : `${attr}="${ref}" matches no id`);
      }
    }
  }

  // 5. Form fields have labels.
  for (const el of all) {
    if (!isFormField(el) || isHiddenFromAT(el)) continue;
    const named = accessibleName(el) !== "";
    record("form_labels", el, named, named ? "" : "no label, aria-label or aria-labelledby (placeholder does not count)");
  }

  // 6. Heading levels don't skip (e.g. h1 -> h3). Descending any amount is fine.
  let prev = 0;
  for (const el of all) {
    const m = /^h([1-6])$/.exec(el.tag);
    if (!m || isHiddenFromAT(el)) continue;
    const lvl = Number(m[1]);
    if (prev !== 0) record("heading_order", el, lvl <= prev + 1, lvl <= prev + 1 ? "" : `h${prev} followed by h${lvl}`);
    prev = lvl;
  }

  // 7. Landmarks (pages only): a main landmark or a named region.
  if (outputKind === "page") {
    const hasMain = all.some((e) => e.tag === "main" || role(e) === "main");
    const named = (e: Element) => (e.attrs["aria-label"] ?? "").trim() !== "" || (e.attrs["aria-labelledby"] ?? "").trim() !== "";
    const namedRegion = all.some((e) => (role(e) === "region" || e.tag === "section") && named(e));
    const ok = hasMain || namedRegion;
    record("landmarks", null, ok, ok ? "" : "page has no <main>, role=main or named region");
  }

  const applicable: number[] = [];
  for (const id of A11Y_CHECKS) {
    const r = checks[id];
    if (r.applicable) { r.score = r.passed / r.inspected; applicable.push(r.score); }
  }
  const score = applicable.length ? applicable.reduce((a, b) => a + b, 0) / applicable.length : null;

  return {
    name: "a11y_hygiene",
    score,
    metadata: {
      ...(score === null && { skipped: "no applicable checks (no images, interactive elements, form fields, ARIA references or headings found)" }),
      output_kind: outputKind,
      elements_inspected: all.length,
      script_elements: all.filter((e) => e.tag === "script").length,
      checks,
      failures,
      failures_truncated: truncated,
      self_reported,
    },
  };
}

export default a11yHygiene;
