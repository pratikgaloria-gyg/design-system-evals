/**
 * Output capture (UDS-525): pull the files a session listed in `artifacts.output_files`
 * from Drive and shape them for the Braintrust event (`output.rendered_html`, `output.assets[]`).
 * Per-file problems are recorded in `skipped`, never thrown: a bad file must not block ingest.
 */
import type { DriveSource } from "./drive.js";
import type { Trace } from "./types.js";

export interface OutputAsset {
  name: string;
  content_type: string;
  size: number;
  drive_file_id: string;
  encoding: "utf8" | "base64";
  content: string;
}
export interface OutputCapture {
  rendered_html?: string;
  rendered_html_name?: string;
  assets: OutputAsset[];
  skipped: { name: string; reason: string }[];
}
export interface CaptureLimits { maxTextBytes: number; maxBinaryBytes: number }

export const DEFAULT_LIMITS: CaptureLimits = { maxTextBytes: 3_000_000, maxBinaryBytes: 1_000_000 };

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): CaptureLimits {
  const n = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d);
  return {
    maxTextBytes: n(env.OUTPUT_MAX_TEXT_BYTES, DEFAULT_LIMITS.maxTextBytes),
    maxBinaryBytes: n(env.OUTPUT_MAX_BINARY_BYTES, DEFAULT_LIMITS.maxBinaryBytes),
  };
}

const EXT_TYPES: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript",
  json: "application/json", svg: "image/svg+xml", txt: "text/plain", md: "text/markdown",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};

export function contentTypeFor(name: string, driveMime: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TYPES[ext] ?? driveMime ?? "application/octet-stream";
}

export const isText = (ct: string) =>
  ct.startsWith("text/") || ct === "application/json" || ct === "image/svg+xml" || ct.endsWith("+xml") || ct === "application/javascript";

const isMainHtml = (name: string, ct: string) => ct === "text/html" && /\.dc\.html?$/i.test(name);

export async function captureOutput(
  files: NonNullable<Trace["artifacts"]["output_files"]>,
  drive: DriveSource,
  limits: CaptureLimits = DEFAULT_LIMITS,
): Promise<OutputCapture> {
  const out: OutputCapture = { assets: [], skipped: [] };
  const loaded: { name: string; id: string; ct: string; data: Buffer }[] = [];

  for (const f of files) {
    try {
      const meta = await drive.meta(f.drive_file_id);
      const ct = contentTypeFor(f.name, meta.mimeType);
      const cap = isText(ct) ? limits.maxTextBytes : limits.maxBinaryBytes;
      if (meta.size !== null && meta.size > cap) { out.skipped.push({ name: f.name, reason: `too_large (${meta.size} > ${cap} bytes)` }); continue; }
      const data = await drive.download(f.drive_file_id);
      if (data.length > cap) { out.skipped.push({ name: f.name, reason: `too_large (${data.length} > ${cap} bytes)` }); continue; }
      loaded.push({ name: f.name, id: f.drive_file_id, ct, data });
    } catch (e) {
      out.skipped.push({ name: f.name, reason: `fetch_failed: ${String((e as Error).message ?? e).slice(0, 200)}` });
    }
  }

  // Main document: prefer *.dc.html, else the first HTML file.
  const main = loaded.find((f) => isMainHtml(f.name, f.ct)) ?? loaded.find((f) => f.ct === "text/html");
  if (main) { out.rendered_html = main.data.toString("utf8"); out.rendered_html_name = main.name; }

  for (const f of loaded) {
    if (f === main) continue;
    const text = isText(f.ct);
    out.assets.push({
      name: f.name, content_type: f.ct, size: f.data.length, drive_file_id: f.id,
      encoding: text ? "utf8" : "base64",
      content: f.data.toString(text ? "utf8" : "base64"),
    });
  }
  return out;
}
