/**
 * Thin adapter over parse5 (spec-compliant HTML5 parser, no browser needed) for static-markup scorers.
 * parse5 does the parsing; this converts its tree into a small `Element` shape that is pleasant to
 * query (lower-case tag, attrs as a record, parent links) and adds a few helpers.
 *
 * Notes:
 * - Like a browser, parse5 wraps fragments in <html><head><body> and repairs malformed markup.
 * - <template> contents are inert (not rendered, not in the accessibility tree), so they are not descended into.
 */
import { parse, type DefaultTreeAdapterMap } from "parse5";

type P5Node = DefaultTreeAdapterMap["childNode"];
type P5Parent = DefaultTreeAdapterMap["document"] | DefaultTreeAdapterMap["element"];

export interface Element {
  tag: string; // lower-case
  attrs: Record<string, string>; // lower-case names; boolean attributes have value ""
  children: Node[];
  parent: Element | null;
  /** Source offsets of the opening tag, for failure snippets. */
  start: number;
  startTagEnd: number;
}
export interface TextNode { text: string; parent: Element | null }
export type Node = Element | TextNode;

export const isElement = (n: Node): n is Element => "tag" in n;

export function parseHtml(src: string): Element {
  const doc = parse(src, { sourceCodeLocationInfo: true });
  const root: Element = { tag: "#root", attrs: {}, children: [], parent: null, start: 0, startTagEnd: 0 };
  const convert = (from: P5Parent, into: Element) => {
    for (const child of from.childNodes as P5Node[]) {
      if (child.nodeName === "#text") {
        into.children.push({ text: (child as DefaultTreeAdapterMap["textNode"]).value, parent: into });
      } else if ("tagName" in child) {
        const loc = child.sourceCodeLocation;
        const el: Element = {
          tag: child.tagName.toLowerCase(),
          attrs: Object.fromEntries(child.attrs.map((a) => [a.name, a.value])),
          children: [],
          parent: into,
          start: (loc?.startTag ?? loc)?.startOffset ?? 0,
          startTagEnd: (loc?.startTag ?? loc)?.endOffset ?? 0,
        };
        into.children.push(el);
        if (el.tag !== "template") convert(child, el);
      }
    }
  };
  convert(doc, root);
  return root;
}

/** Depth-first, document-order walk over elements. */
export function* walk(el: Element): Generator<Element> {
  for (const c of el.children) {
    if (isElement(c)) { yield c; yield* walk(c); }
  }
}

export const hasAttr = (el: Element, name: string) => name in el.attrs;

/** Concatenated text of a subtree. `skipHidden` drops aria-hidden / hidden subtrees; script/style are always skipped. */
export function textContent(el: Element, opts: { skipHidden?: boolean; includeImgAlt?: boolean } = {}): string {
  const parts: string[] = [];
  const rec = (e: Element) => {
    for (const c of e.children) {
      if (!isElement(c)) { parts.push(c.text); continue; }
      if (c.tag === "script" || c.tag === "style") continue;
      if (opts.skipHidden && (c.attrs["aria-hidden"] === "true" || hasAttr(c, "hidden"))) continue;
      if (opts.includeImgAlt && c.tag === "img" && c.attrs.alt) { parts.push(c.attrs.alt); continue; }
      if (opts.includeImgAlt && c.tag === "svg") {
        const t = c.children.find((x): x is Element => isElement(x) && x.tag === "title");
        if (t) { parts.push(textContent(t)); continue; }
      }
      rec(c);
    }
  };
  rec(el);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Short, stable CSS-ish path (without the implied html/body); climbs to the nearest ancestor with an id. */
export function selectorFor(el: Element): string {
  const seg = (e: Element) => {
    if (e.attrs.id) return `${e.tag}#${e.attrs.id}`;
    const sibs = e.parent ? e.parent.children.filter((c): c is Element => isElement(c) && c.tag === e.tag) : [e];
    return sibs.length > 1 ? `${e.tag}:nth-of-type(${sibs.indexOf(e) + 1})` : e.tag;
  };
  const path: string[] = [];
  for (let cur: Element | null = el; cur && !["#root", "html", "body"].includes(cur.tag); cur = cur.parent) {
    path.unshift(seg(cur));
    if (cur.attrs.id) break;
  }
  return path.join(" > ") || el.tag;
}

/** Opening tag of an element exactly as written, whitespace-collapsed and truncated, for failure snippets. */
export function snippetFor(el: Element, src: string, max = 140): string {
  const s = src.slice(el.start, el.startTagEnd).replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
