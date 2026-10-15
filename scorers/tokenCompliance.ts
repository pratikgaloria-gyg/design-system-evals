/**
 * Scorer: token_compliance (UDS-528, epic UDS-526).
 *
 * Deterministic check of how much of the output's styling is built from Compass tokens rather than
 * hard-coded literals. Reads `output.rendered_html` (UDS-525) and a versioned token manifest (see `tokenManifest.ts`;
 * produced by an adapter from whatever the token source of truth currently is, never read from the repo directly).
 *
 * Unit of measure: one value in a style declaration, in three categories.
 *   color:   a colour in color / background / border-color / fill / box-shadow ... (hex, rgb(), hsl(), ...).
 *   type:    a font-family / font-size / font-weight / line-height / letter-spacing value, plus each class a manifest style lists.
 *   spacing: a non-zero length in margin / padding / gap / inset.
 * compliant = `var(--token)` (or a manifest style class), or a rule block that spells out a manifest style by value
 * (font-size + font-weight + line-height all equal). Offender = hard-coded literal, or a var() not in the manifest.
 * Offenders carry a `suggestion` when a manifest token has the same value (8px -> --spacing-1x).
 * var() of a `tier: "primitive"` token is compliant but listed in `metadata.primitives` (primitive used instead of semantic).
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
import { normalizeColor, normalizeLength, type TokenManifest } from "./tokenManifest.js";

export type Category = "color" | "type" | "spacing";
export interface Offender { selector: string; property: string; value: string; category: Category; reason: "hard-coded" | "unknown-token"; suggestion?: string }
export interface Fallback { selector: string; property: string; token: string; fallback: string }
export interface Primitive { selector: string; property: string; token: string }
export interface ValueMatch { selector: string; style: string }
export interface CategoryCount { compliant: number; offending: number; score: number | null }
export interface TokenComplianceMetadata {
  skipped?: string;
  token_list_version: string | null;
  token_list_source: string | null;
  counts: Record<Category, CategoryCount>;
  offenders: Offender[];
  offenders_truncated: number;
  fallbacks: Fallback[];
  primitives: Primitive[];
  value_matches: ValueMatch[];
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
/** Full colour literals: hex, and function calls up to their closing paren (so `rgba(0,0,0,.2)` is one value). */
function colorLiterals(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(COLOR_LITERAL)) {
    if (!m[0].endsWith("(")) { out.push(m[0]); continue; }
    let depth = 1, j = m.index! + m[0].length;
    for (; j < text.length && depth > 0; j++) depth += text[j] === "(" ? 1 : text[j] === ")" ? -1 : 0;
    out.push(text.slice(m.index!, j));
  }
  return out;
}
const COMPOSITE_PROPS = ["font-size", "font-weight", "line-height"] as const;
const normalizeType = (prop: string, v: string) => (prop === "font-size" ? normalizeLength(v) : v.trim().toLowerCase());
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

export function tokenCompliance(args: { output?: unknown }, manifest?: TokenManifest, options: TokenComplianceOptions = {}): TokenComplianceScore {
  const cap = options.maxOffenders ?? 50;
  const counts: Record<Category, CategoryCount> = {
    color: { compliant: 0, offending: 0, score: null },
    type: { compliant: 0, offending: 0, score: null },
    spacing: { compliant: 0, offending: 0, score: null },
  };
  const offenders: Offender[] = [];
  const fallbacks: Fallback[] = [];
  const primitives: Primitive[] = [];
  const valueMatches: ValueMatch[] = [];
  let truncated = 0;
  const meta = (extra: Partial<TokenComplianceMetadata> = {}): TokenComplianceMetadata => ({
    token_list_version: manifest?.version ?? null, token_list_source: manifest?.source ?? null,
    counts, offenders, offenders_truncated: truncated, fallbacks, primitives, value_matches: valueMatches, ...extra,
  });

  const src = (args.output as { rendered_html?: unknown } | undefined)?.rendered_html;
  if (typeof src !== "string" || src.trim() === "") return { name: "token_compliance", score: null, metadata: meta({ skipped: "no rendered_html" }) };

  const tokenByName = manifest ? new Map(manifest.tokens.map((t) => [t.name, t])) : null;
  const classNames = manifest ? new Set(manifest.styles.flatMap((st) => st.classNames ?? [])) : null;
  const hintIndex = new Map<string, Map<string, string[]>>();
  const indexHints = (category: string, normalize: (v: string) => string) => {
    const m = new Map<string, string[]>();
    for (const t of manifest?.tokens ?? []) {
      if (t.category !== category) continue;
      for (const v of t.values ?? []) {
        const key = normalize(v), names = m.get(key) ?? [];
        if (!names.includes(t.name)) names.push(t.name);
        m.set(key, names);
      }
    }
    hintIndex.set(category, m);
  };
  indexHints("color", normalizeColor);
  indexHints("spacing", normalizeLength);
  const hint = (category: string, normalized: string) => {
    const names = hintIndex.get(category)?.get(normalized);
    return names?.length ? names.slice(0, 3).map((n) => `var(${n})`).join(" or ") : undefined;
  };
  const sizeHint = (px: string) => {
    const names = (manifest?.styles ?? []).filter((st) => st.match["font-size"] !== undefined && normalizeLength(st.match["font-size"]) === px).map((st) => st.name);
    return names.length ? `font-size of type style ${names.slice(0, 3).join(", ")}` : undefined;
  };

  const ok = (cat: Category) => { counts[cat].compliant++; };
  const bad = (selector: string, property: string, value: string, category: Category, reason: Offender["reason"], suggestion?: string) => {
    counts[category].offending++;
    if (offenders.length < cap) offenders.push({ selector, property, value, category, reason, ...(suggestion ? { suggestion } : {}) });
    else truncated++;
  };

  const scoreDeclaration = (selector: string, property: string, value: string) => {
    const category: Category | null = COLOR_PROPS.has(property) ? "color" : TYPE_PROPS.has(property) ? "type" : SPACING_PROPS.has(property) ? "spacing" : null;
    if (!category || property.startsWith("--")) return;
    const { vars, rest } = splitVars(value);
    for (const v of vars) {
      if (!v.name.startsWith("--")) continue;
      const token = tokenByName?.get(v.name);
      if (tokenByName && !token) { bad(selector, property, `var(${v.name})`, category, "unknown-token"); continue; }
      ok(category);
      if (token?.tier === "primitive") primitives.push({ selector, property, token: v.name });
      if (v.fallback) fallbacks.push({ selector, property, token: v.name, fallback: v.fallback });
    }
    if (category === "color") {
      for (const m of colorLiterals(rest)) bad(selector, property, m, "color", "hard-coded", hint("color", normalizeColor(m)));
    } else if (category === "type") {
      const v = rest.trim();
      if (!v) return;
      // font-family is a list (one unit per list); every other type property is a single value.
      if (!KEYWORDS.has(v.toLowerCase())) bad(selector, property, v, "type", "hard-coded", property === "font-size" ? sizeHint(normalizeLength(v)) : undefined);
    } else {
      for (const m of rest.match(LENGTH_LITERAL) ?? []) bad(selector, property, m, "spacing", "hard-coded", hint("spacing", normalizeLength(m)));
    }
  };

  const scoreBlock = (selector: string, declarations: [string, string][]) => {
    const skip = new Set<string>();
    const literal = (prop: string) => {
      const d = declarations.find(([p]) => p === prop);
      if (!d) return null;
      const { vars, rest } = splitVars(d[1]);
      return vars.length ? null : rest.trim();
    };
    const declared = COMPOSITE_PROPS.map((p) => [p, literal(p)] as const);
    if (manifest && declared.every(([, v]) => v !== null)) {
      const style = manifest.styles.find((st) => COMPOSITE_PROPS.every((p) => st.match[p] !== undefined && normalizeType(p, st.match[p]) === normalizeType(p, literal(p)!)));
      if (style) {
        for (const p of COMPOSITE_PROPS) { skip.add(p); ok("type"); }
        valueMatches.push({ selector, style: style.name });
      }
    }
    for (const [p, v] of declarations) if (!skip.has(p)) scoreDeclaration(selector, p, v);
  };

  const root = parseHtml(src);
  for (const el of walk(root)) {
    if (el.tag === "style") {
      const css = el.children.map((c) => (isElement(c) ? "" : c.text)).join("");
      for (const rule of parseRules(css)) scoreBlock(rule.selector, parseDeclarations(rule.declarations));
    }
    if (el.attrs.style) scoreBlock(`${selectorFor(el)} [style]`, parseDeclarations(el.attrs.style));
    for (const c of (el.attrs.class ?? "").split(/\s+/)) if (classNames ? classNames.has(c) : c.startsWith("t-")) ok("type");
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
