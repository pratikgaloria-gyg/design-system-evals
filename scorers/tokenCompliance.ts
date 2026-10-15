/**
 * Scorer: token_compliance (UDS-528, epic UDS-526).
 *
 * Deterministic check of how much of the output's styling is built from Compass tokens rather than
 * hard-coded literals. Reads `output.rendered_html` (UDS-525) and a versioned token list (`tokens.json`,
 * exported from compass-pcl; see `TokenList`).
 *
 * Unit of measure: one value in a style declaration, in three categories.
 *   color:   a colour in color / background / border-color / fill / box-shadow ... (hex, rgb(), hsl(), ...).
 *   type:    a font-family / font-size / font-weight / line-height / letter-spacing value, plus each `.t-*` class.
 *   spacing: a non-zero length in margin / padding / gap / inset.
 * compliant = `var(--token)` (or a `.t-*` type class). Offender = hard-coded literal, or a var() that is not in the token list.
 * Score = compliant / (compliant + offenders) over all categories, null when there is nothing to measure.
 *
 * Tokens with hard-coded fallbacks, `var(--shadow-elevation-32, 0 8px ...)`, count as COMPLIANT (the token
 * is what the author reached for) and are listed separately in `metadata.fallbacks`.
 *
 * Scope: inline <style> blocks and style="" attributes only. No computed styles, no external CSS.
 * Not judged: whether a literal was justified; component usage (component_compliance).
 * Not measured: named colours (`red`), keyword values (`inherit`, `auto`, `0`), shorthand sub-values other than colour in border/background/box-shadow.
 */
import { type Element, isElement, parseHtml, selectorFor, walk } from "./html.js";

export interface TokenList {
  version: string;
  /** CSS custom property names, with the leading `--`. */
  cssVariables: string[];
  /** Type class names, without the leading dot, e.g. "t-heading-md". Prefix `t-` is always accepted when this is omitted. */
  typeClasses?: string[];
}
export type Category = "color" | "type" | "spacing";
export interface Offender { selector: string; property: string; value: string; category: Category; reason: "hard-coded" | "unknown-token" }
export interface Fallback { selector: string; property: string; token: string; fallback: string }
export interface CategoryCount { compliant: number; offending: number; score: number | null }
export interface TokenComplianceMetadata {
  skipped?: string;
  token_list_version: string | null;
  counts: Record<Category, CategoryCount>;
  offenders: Offender[];
  offenders_truncated: number;
  fallbacks: Fallback[];
}
export interface TokenComplianceScore { name: "token_compliance"; score: number | null; metadata: TokenComplianceMetadata }
export interface TokenComplianceOptions { maxOffenders?: number }

const COLOR_PROPS = new Set([
  "color", "background", "background-color", "border", "border-color", "border-top", "border-right", "border-bottom", "border-left",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline", "outline-color",
  "fill", "stroke", "box-shadow", "text-shadow", "text-decoration-color", "caret-color", "accent-color",
]);
const TYPE_PROPS = new Set(["font-family", "font-size", "font-weight", "line-height", "letter-spacing"]);
const SPACING_PROPS = new Set([
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding", "padding-top", "padding-right",
  "padding-bottom", "padding-left", "gap", "row-gap", "column-gap", "top", "right", "bottom", "left", "inset",
]);
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
const LENGTH_LITERAL = /(?<![\w#.-])[+-]?(?:\d+\.?\d*|\.\d+)(?:px|rem|em)\b/gi;
const KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "normal", "auto", "none", "currentcolor", "transparent", "0"]);

/** Split a declaration value into top-level var() calls and the remaining text. */
function splitVars(value: string): { vars: { name: string; fallback: string | null }[]; rest: string } {
  const vars: { name: string; fallback: string | null }[] = [];
  let rest = "";
  for (let i = 0; i < value.length; ) {
    if (value.startsWith("var(", i)) {
      let depth = 1, j = i + 4;
      for (; j < value.length && depth > 0; j++) depth += value[j] === "(" ? 1 : value[j] === ")" ? -1 : 0;
      const body = value.slice(i + 4, j - 1);
      const comma = body.indexOf(",");
      vars.push({ name: (comma < 0 ? body : body.slice(0, comma)).trim(), fallback: comma < 0 ? null : body.slice(comma + 1).trim() });
      rest += " ";
      i = j;
    } else rest += value[i++];
  }
  return { vars, rest };
}

/** Flatten CSS text into [selector, declarations] pairs; @media/@supports bodies are descended into, other at-rules skipped. */
function parseRules(css: string): { selector: string; declarations: string }[] {
  const out: { selector: string; declarations: string }[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rec = (s: string) => {
    for (let i = 0; i < s.length; ) {
      const open = s.indexOf("{", i);
      if (open < 0) break;
      let depth = 1, j = open + 1;
      for (; j < s.length && depth > 0; j++) depth += s[j] === "{" ? 1 : s[j] === "}" ? -1 : 0;
      const prelude = s.slice(i, open).trim();
      const body = s.slice(open + 1, j - 1);
      if (prelude.startsWith("@")) { if (/^@(media|supports|layer|container)\b/i.test(prelude)) rec(body); }
      else out.push({ selector: prelude.replace(/\s+/g, " "), declarations: body });
      i = j;
    }
  };
  rec(text);
  return out;
}

/** Declarations as [property, value]; tolerant of `;` inside parentheses (data: URIs) and `!important`. */
function parseDeclarations(body: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0, start = 0;
  const push = (chunk: string) => {
    const colon = chunk.indexOf(":");
    if (colon < 0) return;
    out.push([chunk.slice(0, colon).trim().toLowerCase(), chunk.slice(colon + 1).replace(/!important/i, "").trim()]);
  };
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (body[i] === ";" && depth === 0) { push(body.slice(start, i)); start = i + 1; }
  }
  push(body.slice(start));
  return out;
}

export function tokenCompliance(args: { output?: unknown }, tokens?: TokenList, options: TokenComplianceOptions = {}): TokenComplianceScore {
  const cap = options.maxOffenders ?? 50;
  const counts: Record<Category, CategoryCount> = {
    color: { compliant: 0, offending: 0, score: null },
    type: { compliant: 0, offending: 0, score: null },
    spacing: { compliant: 0, offending: 0, score: null },
  };
  const offenders: Offender[] = [];
  const fallbacks: Fallback[] = [];
  let truncated = 0;
  const meta = (extra: Partial<TokenComplianceMetadata> = {}): TokenComplianceMetadata => ({
    token_list_version: tokens?.version ?? null, counts, offenders, offenders_truncated: truncated, fallbacks, ...extra,
  });

  const src = (args.output as { rendered_html?: unknown } | undefined)?.rendered_html;
  if (typeof src !== "string" || src.trim() === "") return { name: "token_compliance", score: null, metadata: meta({ skipped: "no rendered_html" }) };

  const known = tokens ? new Set(tokens.cssVariables) : null;
  const typeClasses = tokens?.typeClasses ? new Set(tokens.typeClasses) : null;
  const isTypeClass = (c: string) => (typeClasses ? typeClasses.has(c) : c.startsWith("t-"));

  const ok = (cat: Category) => { counts[cat].compliant++; };
  const bad = (selector: string, property: string, value: string, category: Category, reason: Offender["reason"]) => {
    counts[category].offending++;
    if (offenders.length < cap) offenders.push({ selector, property, value, category, reason });
    else truncated++;
  };

  const scoreDeclaration = (selector: string, property: string, value: string) => {
    const category: Category | null = COLOR_PROPS.has(property) ? "color" : TYPE_PROPS.has(property) ? "type" : SPACING_PROPS.has(property) ? "spacing" : null;
    if (!category || property.startsWith("--")) return;
    const { vars, rest } = splitVars(value);
    for (const v of vars) {
      if (!v.name.startsWith("--")) continue;
      if (known && !known.has(v.name)) { bad(selector, property, `var(${v.name})`, category, "unknown-token"); continue; }
      ok(category);
      if (v.fallback) fallbacks.push({ selector, property, token: v.name, fallback: v.fallback });
    }
    if (category === "color") {
      for (const m of rest.match(COLOR_LITERAL) ?? []) bad(selector, property, m.replace(/\($/, "()"), "color", "hard-coded");
    } else if (category === "type") {
      const v = rest.trim();
      if (!v) return;
      // font-family is a list (one unit per list); every other type property is a single value.
      if (!KEYWORDS.has(v.toLowerCase())) bad(selector, property, v, "type", "hard-coded");
    } else {
      for (const m of rest.match(LENGTH_LITERAL) ?? []) bad(selector, property, m, "spacing", "hard-coded");
    }
  };

  const root = parseHtml(src);
  for (const el of walk(root)) {
    if (el.tag === "style") {
      const css = el.children.map((c) => (isElement(c) ? "" : c.text)).join("");
      for (const rule of parseRules(css)) for (const [p, v] of parseDeclarations(rule.declarations)) scoreDeclaration(rule.selector, p, v);
    }
    if (el.attrs.style) for (const [p, v] of parseDeclarations(el.attrs.style)) scoreDeclaration(`${selectorFor(el)} [style]`, p, v);
    for (const c of (el.attrs.class ?? "").split(/\s+/)) if (c.startsWith("t-") && isTypeClass(c)) ok("type");
  }

  let compliant = 0, offending = 0;
  for (const cat of Object.keys(counts) as Category[]) {
    const c = counts[cat];
    const n = c.compliant + c.offending;
    c.score = n ? c.compliant / n : null;
    compliant += c.compliant; offending += c.offending;
  }
  const score = compliant + offending ? compliant / (compliant + offending) : null;
  return { name: "token_compliance", score, metadata: meta(score === null ? { skipped: "no colour, typography or spacing values found in inline styles" } : {}) };
}

export default tokenCompliance;
