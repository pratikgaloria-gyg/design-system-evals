/**
 * Token manifest: the only token input the token_compliance scorer knows about (UDS-528).
 *
 * The scorer never reads SCSS, StyleX, Figma or Claude Design files. Adapters (see `adapters/`) turn whatever the
 * current source of truth is into this shape, so replacing the source later means writing a new adapter, not
 * touching the scorer.
 *
 *   tokens: things referenced by name, `var(--name)`. `values` are the resolved values (light + dark + variants),
 *           used to say "this literal equals token X".
 *   styles: composite or generated tokens matched by value, e.g. typography styles (font-size + weight + line-height).
 *           `classNames` lists CSS classes that apply the style, when there are any.
 *   category / tier are free strings from the source. The scorer reads "color", "spacing", "type" for hints and
 *   tier "primitive" for the primitive-instead-of-semantic flag; anything else is carried through untouched.
 */
import { z } from "zod";

export const manifestSchema = z.object({
  version: z.string().min(1),
  source: z.string().min(1),
  tokens: z.array(z.object({
    name: z.string().min(1),
    category: z.string().min(1),
    tier: z.string().optional(),
    values: z.array(z.string()).optional(),
  })),
  styles: z.array(z.object({
    name: z.string().min(1),
    category: z.string().min(1),
    match: z.record(z.string(), z.string()),
    classNames: z.array(z.string()).optional(),
  })).default([]),
});
export type TokenManifest = z.output<typeof manifestSchema>;
export type ManifestToken = TokenManifest["tokens"][number];
export type ManifestStyle = TokenManifest["styles"][number];

export function parseManifest(data: unknown): TokenManifest {
  return manifestSchema.parse(data);
}

const toHex = (n: number) => Math.round(n).toString(16).padStart(2, "0");
const channel = (s: string) => (s.endsWith("%") ? (parseFloat(s) / 100) * 255 : parseFloat(s));
const alphaOf = (s: string | undefined) => (s === undefined ? 1 : s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s));
const fromRgb = (r: number, g: number, b: number, a: number) =>
  a >= 0.995 ? `#${toHex(r)}${toHex(g)}${toHex(b)}` : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Math.round(a * 100) / 100})`;

/** Canonical form so `#FFF`, `rgb(255 255 255)` and `rgba(255,255,255,1)` compare equal. Unknown syntaxes are only lower-cased and de-spaced. */
export function normalizeColor(value: string): string {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length === 6 || h.length === 8) {
      const a = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
      return fromRgb(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a);
    }
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (rgb) return fromRgb(channel(rgb[1]), channel(rgb[2]), channel(rgb[3]), alphaOf(rgb[4]));
  return v.replace(/\s+/g, "");
}

/** `0.5rem` / `8px` -> `8px` (rem at 16px). Other values are returned lower-cased and trimmed. */
export function normalizeLength(value: string): string {
  const v = value.trim().toLowerCase();
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|rem)$/.exec(v);
  if (!m) return v;
  const px = m[2] === "rem" ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
  return `${Math.round(px * 100) / 100}px`;
}
