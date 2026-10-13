/** Confluence Cloud REST v2: list session pages under a parent, extract the trace JSON block. */

export interface AdfNode { type: string; attrs?: Record<string, unknown>; text?: string; content?: AdfNode[] }
export interface Page { id: string; title: string; url: string; version: number; lastModified: string | null; adf: AdfNode }

const JSON_LANGS = new Set(["json", "json5"]);

export class ConfluenceClient {
  private base: string;
  private auth: string;

  constructor(opts: { baseUrl?: string; email?: string; token?: string } = {}) {
    this.base = (opts.baseUrl ?? need("CONFLUENCE_BASE_URL")).replace(/\/$/, ""); // e.g. https://getyourguide.atlassian.net/wiki
    const email = opts.email ?? need("ATLASSIAN_EMAIL");
    const token = opts.token ?? need("ATLASSIAN_API_TOKEN");
    this.auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await fetch(url, { headers: { Authorization: this.auth, Accept: "application/json" } });
    if (!r.ok) throw new Error(`Confluence ${r.status} ${path}: ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as T;
  }

  /** All page descendants (direct + nested) of a parent page. */
  async *descendants(parentId: string): AsyncGenerator<{ id: string; title: string }> {
    let cursor: string | undefined;
    for (;;) {
      const params: Record<string, string> = { limit: "100", depth: "5" };
      if (cursor) params.cursor = cursor;
      const data = await this.get<{ results: { id: string; title: string; type: string }[]; _links?: { next?: string } }>(
        `/api/v2/pages/${parentId}/descendants`, params);
      for (const item of data.results) if (item.type === "page") yield { id: String(item.id), title: item.title };
      const next = data._links?.next;
      if (!next) return;
      cursor = new URL(next, this.base).searchParams.get("cursor") ?? undefined;
    }
  }

  async page(pageId: string): Promise<Page> {
    const d = await this.get<{ id: string; title: string; version: { number: number; createdAt?: string }; body: { atlas_doc_format: { value: string } }; _links: { webui: string } }>(
      `/api/v2/pages/${pageId}`, { "body-format": "atlas_doc_format" });
    return {
      id: String(d.id),
      title: d.title,
      url: this.base + d._links.webui,
      version: d.version.number,
      lastModified: d.version.createdAt ?? null,
      adf: JSON.parse(d.body.atlas_doc_format.value),
    };
  }
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function* walk(node: AdfNode): Generator<AdfNode> {
  yield node;
  for (const c of node.content ?? []) yield* walk(c);
}

const textOf = (n: AdfNode) => (n.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");

/**
 * The parsed trace from the LAST `codeBlock` with language json whose body parses to an
 * object carrying `session_id`. Only that block is treated as data; prose is ignored.
 */
export function extractTraceJson(adf: AdfNode): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (const n of walk(adf)) {
    if (n.type !== "codeBlock") continue;
    if (!JSON_LANGS.has(String(n.attrs?.language ?? "").toLowerCase())) continue;
    try {
      const obj = JSON.parse(textOf(n));
      if (obj && typeof obj === "object" && !Array.isArray(obj) && "session_id" in obj) found = obj;
    } catch { /* not JSON, skip */ }
  }
  return found;
}

const STORAGE_CODE = /<ac:structured-macro[^>]*ac:name="code"[^>]*>[\s\S]*?<ac:parameter ac:name="language">json<\/ac:parameter>[\s\S]*?<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>/g;

/** Fallback for Confluence storage format (REST v1 / body.storage). */
export function extractTraceJsonFromStorage(storageHtml: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  for (const m of storageHtml.matchAll(STORAGE_CODE)) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj && typeof obj === "object" && "session_id" in obj) found = obj;
    } catch { /* skip */ }
  }
  return found;
}
