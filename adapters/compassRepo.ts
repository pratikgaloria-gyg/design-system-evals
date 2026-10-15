/**
 * Adapter: compass repo (getyourguide/compass, `packages/compass/styles`) -> TokenManifest.
 *
 * Interim source of truth for token_compliance (UDS-528). Replace this file, not the scorer, when a shared token spec exists.
 * Reads SCSS as text, no Sass compiler:
 *   themes/_themes.scss             colour tokens, `$theme-tokens`, `-low-risk` and `-full` maps -> `--<name>`, light/dark/variant values merged
 *   variables/_spacing.scss         `--spacing-*` custom properties
 *   variables/_elevations-new.scss  `--effect-*` shadows
 *   themes/_font-family.scss        `--font-family`
 *   variables/_typography-new.scss  `font-style-new` mixin -> type styles matched by value (heading-md, text-regular-sm, ...)
 * Not covered: palette primitives (SCSS-only, never CSS vars in this repo), radius (SCSS-only), legacy typography.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ManifestStyle, ManifestToken, TokenManifest } from "../scorers/tokenManifest.js";

const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** `$name: value;` lines -> map. */
function scssVariables(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of stripComments(text).matchAll(/^\$([\w-]+):\s*([^;]+);/gm)) out.set(m[1], m[2].trim());
  return out;
}

type Palettes = { old: Map<string, string>; fresh: Map<string, string> };
type Aliases = Map<string, Map<string, string>>;

/** Which palette a `@use ... as alias` namespace points at, per file (`palette` is the new palette in some files and the old one in others). */
function aliasesFor(scss: string, p: Palettes): Aliases {
  const out: Aliases = new Map();
  for (const m of stripComments(scss).matchAll(/@use\s+"[^"]*?\/(palette-new|palette)"(?:\s+as\s+([\w-]+))?/g)) {
    out.set(m[2] ?? m[1], m[1] === "palette-new" ? p.fresh : p.old);
  }
  return out;
}

/** Resolve `<alias>.$x`, `rgba(<palette ref>, a)` and `#{...}` interpolation. Unresolvable text is returned as-is. */
function resolveValue(raw: string, aliases: Aliases): string {
  let v = raw.trim()
    .replace(/#\{\s*([^}]+?)\s*\}/g, "$1")
    .replace(/([\w-]+)\.\$([\w-]+)/g, (all, alias: string, name: string) => aliases.get(alias)?.get(name) ?? all);
  v = v.replace(/rgba\(\s*(#[0-9a-f]{6})\s*,\s*([\d.]+)\s*\)/gi, (_all, hex: string, alpha: string) =>
    `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${alpha})`);
  return v.replace(/\s+/g, " ").trim();
}

/** Body of `$name: ( ... );` with balanced parens. */
function scssMaps(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const src = stripComments(text);
  for (const m of src.matchAll(/^\$([\w-]+):\s*\(/gm)) {
    let depth = 1, j = m.index! + m[0].length;
    for (; j < src.length && depth > 0; j++) depth += src[j] === "(" ? 1 : src[j] === ")" ? -1 : 0;
    out.set(m[1], src.slice(m.index! + m[0].length, j - 1));
  }
  return out;
}

function themeTokens(themes: string, aliases: Aliases): ManifestToken[] {
  const byName = new Map<string, Set<string>>();
  const entry = /([\w-]+):\s*\(\s*light:\s*((?:[^,()]|\([^()]*\))+),\s*dark:\s*((?:[^,()]|\([^()]*\))+?),?\s*\)/g;
  for (const [mapName, body] of scssMaps(themes)) {
    if (!mapName.startsWith("theme-tokens")) continue;
    for (const m of body.matchAll(entry)) {
      const set = byName.get(m[1]) ?? new Set<string>();
      for (const v of [m[2], m[3]]) set.add(resolveValue(v, aliases));
      byName.set(m[1], set);
    }
  }
  return [...byName].map(([name, values]) => ({ name: `--${name}`, category: "color", tier: "semantic", values: [...values] }));
}

function rootCustomProperties(text: string, category: string, aliases: Aliases): ManifestToken[] {
  const out = new Map<string, Set<string>>();
  for (const m of stripComments(text).matchAll(/(?:^|[;{\s])--([\w-]+):\s*([^;]+);/g)) {
    const set = out.get(m[1]) ?? new Set<string>();
    set.add(resolveValue(m[2], aliases));
    out.set(m[1], set);
  }
  return [...out].map(([name, values]) => ({ name: `--${name}`, category, tier: "semantic", values: [...values] }));
}

function typeStyles(typography: string, tokensScss: string): ManifestStyle[] {
  const vars = scssVariables(tokensScss);
  const lookup = (ref: string) => vars.get(ref.replace(/^.*\$/, "")) ?? ref;
  const styles: ManifestStyle[] = [];
  const aliases: [name: string, base: string][] = []; // e.g. text-link-regular-xs = text-regular-xs + underline
  for (const m of stripComments(typography).matchAll(/\$style == "([\w-]+)"\s*\{([^}]*)\}/g)) {
    const body = m[2];
    const size = /font-size:\s*[\w.-]*get-font-value\(\s*([^,\s]+)\s*,/.exec(body)?.[1];
    const lineHeight = /line-height:\s*([^;]+);/.exec(body)?.[1];
    const weight = /font-weight:\s*([^;]+);/.exec(body)?.[1];
    const base = /@include\s+font-style-new\(\s*"([\w-]+)"/.exec(body)?.[1];
    if (base && !size) { aliases.push([m[1], base]); continue; }
    if (!size || !lineHeight || !weight) continue;
    styles.push({
      name: m[1], category: "type",
      match: { "font-size": lookup(size), "line-height": lookup(lineHeight.trim()), "font-weight": lookup(weight.trim()) },
    });
  }
  for (const [name, base] of aliases) {
    const from = styles.find((st) => st.name === base);
    if (from) styles.push({ ...from, name });
  }
  return styles;
}

export function buildCompassManifest(compassRoot: string, ref: { sha: string }): TokenManifest {
  const styles = "packages/compass/styles";
  const palettes: Palettes = {
    old: scssVariables(read(compassRoot, `${styles}/variables/_palette.scss`)),
    fresh: scssVariables(read(compassRoot, `${styles}/variables/_palette-new.scss`)),
  };
  const file = (rel: string) => read(compassRoot, `${styles}/${rel}`);
  const [themes, spacing, elevations, fontFamily] = ["themes/_themes.scss", "variables/_spacing.scss", "variables/_elevations-new.scss", "themes/_font-family.scss"].map(file);
  const tokens = [
    ...themeTokens(themes, aliasesFor(themes, palettes)),
    ...rootCustomProperties(spacing, "spacing", aliasesFor(spacing, palettes)),
    ...rootCustomProperties(elevations, "shadow", aliasesFor(elevations, palettes)),
    ...rootCustomProperties(fontFamily, "type", aliasesFor(fontFamily, palettes)),
  ];
  return {
    version: `compass-${ref.sha.slice(0, 7)}`,
    source: `compass-repo@${ref.sha}`,
    tokens,
    styles: typeStyles(read(compassRoot, `${styles}/variables/_typography-new.scss`), read(compassRoot, `${styles}/variables/_typography-tokens.scss`)),
  };
}
