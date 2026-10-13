/**
 * CLI (run with `npm run ingest -- <cmd>` or `tsx src/cli.ts <cmd>`):
 *
 *   validate <trace.json>
 *   render   <trace.json>                 > page.html
 *   push     <trace.json> [--dry-run]     push a local JSON straight to Braintrust (Phase 0 exit)
 *   run      [--dry-run] [--parent ID] [--page ID ...]   ingest Confluence pages into Braintrust
 */
import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { BraintrustClient } from "./braintrust.js";
import { ConfluenceClient, extractTraceJson } from "./confluence.js";
import { renderPage } from "./renderPage.js";
import { DriveClient } from "./drive.js";
import { captureOutput, limitsFromEnv, type OutputCapture } from "./output.js";
import { normalize, toBraintrustEvent, validate } from "./trace.js";
import type { BraintrustEvent, Trace } from "./types.js";

function loadDotEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const log = (s: string) => process.stderr.write(s + "\n");

/** Fetch the session's output files from Drive (UDS-525). Never throws; no creds or no files = no capture. */
let driveClient: DriveClient | null | undefined;
async function captureFor(t: Trace): Promise<OutputCapture | undefined> {
  const files = t.artifacts.output_files;
  if (!files?.length) return undefined;
  if (driveClient === undefined) driveClient = DriveClient.fromEnv();
  if (!driveClient) { log(`warning: ${t.session_id} lists output_files but no Google credentials are set; skipping output capture`); return undefined; }
  const cap = await captureOutput(files, driveClient, limitsFromEnv());
  for (const s of cap.skipped) log(`output skip: ${t.session_id}: ${s.name}: ${s.reason}`);
  return cap;
}

async function cmdValidate(path: string) {
  const t = normalize(readJson(path));
  const errs = validate(t);
  console.log(errs.length ? errs.join("\n") : `OK: ${t.session_id}`);
  return errs.length ? 1 : 0;
}

async function cmdRender(path: string) {
  process.stdout.write(renderPage(readJson(path)));
  return 0;
}

async function cmdPush(path: string, dryRun: boolean) {
  const t = normalize(readJson(path));
  const errs = validate(t);
  if (errs.length) { log(errs.join("\n")); return 1; }
  const ev = toBraintrustEvent(t, t.session_id, { kind: "local-file", path }, await captureFor(t));
  if (dryRun) { console.log(JSON.stringify(ev, null, 2)); return 0; }
  const bt = new BraintrustClient();
  console.log(JSON.stringify(await bt.insertLogs([ev])));
  log(`inserted ${ev.id} into project ${bt.projectId}`);
  return 0;
}

async function cmdRun(opts: { dryRun: boolean; parent?: string; pages: string[] }) {
  const conf = new ConfluenceClient();
  let pageIds = opts.pages;
  if (!pageIds.length) {
    const parent = opts.parent ?? process.env.CONFLUENCE_PARENT_PAGE_ID;
    if (!parent) throw new Error("Missing --parent or CONFLUENCE_PARENT_PAGE_ID");
    for await (const p of conf.descendants(parent)) pageIds.push(p.id);
  }
  const events: BraintrustEvent[] = [];
  const seen = new Map<string, string>();
  const skipped: [string, string][] = [];
  for (const id of pageIds) {
    const page = await conf.page(id);
    const raw = extractTraceJson(page.adf);
    if (!raw) { skipped.push([page.title, "no json code block with session_id"]); continue; }
    const t = normalize(raw);
    const errs = validate(t);
    if (errs.length) { skipped.push([page.title, errs.slice(0, 3).join("; ")]); continue; }
    const sid = t.session_id;
    let eventId = sid;
    if (seen.has(sid)) {
      eventId = `${sid}__p${page.id}`;
      log(`warning: duplicate session_id '${sid}' on pages ${seen.get(sid)} and ${page.id}; using ${eventId}`);
    } else seen.set(sid, page.id);
    events.push(toBraintrustEvent(t, eventId, {
      kind: "confluence", page_id: page.id, page_url: page.url, page_version: page.version, page_last_modified: page.lastModified,
    }, await captureFor(t)));
  }
  for (const [title, why] of skipped) log(`skip: ${title}: ${why}`);
  log(`${events.length} trace(s) ready, ${skipped.length} page(s) skipped`);
  if (opts.dryRun) { console.log(JSON.stringify(events, null, 2)); return 0; }
  if (events.length) console.log(JSON.stringify(await new BraintrustClient().insertLogs(events)));
  return 0;
}

async function main() {
  loadDotEnv();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false }, parent: { type: "string" }, page: { type: "string", multiple: true } },
  });
  const [cmd, arg] = positionals;
  switch (cmd) {
    case "validate": return cmdValidate(arg);
    case "render": return cmdRender(arg);
    case "push": return cmdPush(arg, values["dry-run"]!);
    case "run": return cmdRun({ dryRun: values["dry-run"]!, parent: values.parent, pages: values.page ?? [] });
    default:
      log("usage: ingest <validate|render|push|run> ... (see src/cli.ts)");
      return 2;
  }
}

main().then((code) => process.exit(code)).catch((e) => { log(String(e?.stack ?? e)); process.exit(1); });
