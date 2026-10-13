import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { captureOutput, DEFAULT_LIMITS } from "../src/output.js";
import { DriveClient, loadServiceAccountKey, type DriveSource } from "../src/drive.js";
import { normalize, toBraintrustEvent, validate } from "../src/trace.js";

const HTML = readFileSync(new URL("./fixtures/output/Empty Bookings Card.dc.html", import.meta.url), "utf8");
const CSS = ".card { padding: 16px; }";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const FILES = [
  { name: "Empty Bookings Card.dc.html", drive_file_id: "f-html" },
  { name: "assets/card.css", drive_file_id: "f-css" },
  { name: "assets/icons/tickets.svg", drive_file_id: "f-svg" },
  { name: "assets/hero.png", drive_file_id: "f-png" },
];

/** Fake Drive: id -> {name, mime, data}. Missing id throws like a 404. */
function fakeDrive(store: Record<string, { mime: string; data: Buffer; sizeOverride?: number }>): DriveSource & { downloads: string[] } {
  const downloads: string[] = [];
  return {
    downloads,
    async meta(id) {
      const f = store[id];
      if (!f) throw new Error("Drive 404");
      return { name: id, mimeType: f.mime, size: f.sizeOverride ?? f.data.length };
    },
    async download(id) { downloads.push(id); return store[id].data; },
  };
}

const store = () => ({
  "f-html": { mime: "text/html", data: Buffer.from(HTML) },
  "f-css": { mime: "text/css", data: Buffer.from(CSS) },
  "f-svg": { mime: "image/svg+xml", data: Buffer.from(SVG) },
  "f-png": { mime: "image/png", data: PNG },
});

const baseTrace = () => {
  const t = normalize(JSON.parse(readFileSync(new URL("./fixtures/traveler-onboarding-carousel.json", import.meta.url), "utf8")));
  t.artifacts.output_files = structuredClone(FILES);
  return t;
};

test("schema accepts output_files and rejects a malformed entry", () => {
  const t = baseTrace();
  assert.deepEqual(validate(t), []);
  (t.artifacts.output_files as any)[0] = { name: "x.html" };
  assert.ok(validate(t).some((e) => e.includes("drive_file_id")));
});

test("captures main HTML byte-for-byte and the rest as assets", async () => {
  const cap = await captureOutput(FILES, fakeDrive(store()));
  assert.equal(cap.rendered_html, HTML);
  assert.equal(cap.rendered_html_name, "Empty Bookings Card.dc.html");
  assert.deepEqual(cap.skipped, []);
  assert.deepEqual(cap.assets.map((a) => [a.name, a.content_type, a.encoding]), [
    ["assets/card.css", "text/css", "utf8"],
    ["assets/icons/tickets.svg", "image/svg+xml", "utf8"],
    ["assets/hero.png", "image/png", "base64"],
  ]);
  assert.equal(Buffer.from(cap.assets[2].content, "base64").equals(PNG), true);
});

test("event carries output.rendered_html and output.assets", async () => {
  const t = baseTrace();
  const ev = toBraintrustEvent(t, t.session_id, {}, await captureOutput(FILES, fakeDrive(store())));
  const out = ev.output as Record<string, any>;
  assert.equal(out.rendered_html, HTML);
  assert.equal(out.assets.length, 3);
  assert.equal(ev.metadata.has_rendered_html, true);
  assert.ok(!("output_skipped" in out));
});

test("event without capture has no rendered_html", () => {
  const t = baseTrace();
  const ev = toBraintrustEvent(t, t.session_id);
  assert.ok(!("rendered_html" in (ev.output as object)));
  assert.equal(ev.metadata.has_rendered_html, false);
});

test("binaries over the cap are skipped without downloading; text still captured", async () => {
  const s = store();
  (s["f-png"] as any).sizeOverride = DEFAULT_LIMITS.maxBinaryBytes + 1;
  const drive = fakeDrive(s);
  const cap = await captureOutput(FILES, drive);
  assert.equal(cap.rendered_html, HTML);
  assert.ok(!drive.downloads.includes("f-png"));
  assert.equal(cap.skipped.length, 1);
  assert.match(cap.skipped[0].reason, /^too_large/);
  assert.equal(cap.assets.some((a) => a.name === "assets/hero.png"), false);
});

test("a missing file is recorded, not thrown", async () => {
  const s: any = store();
  delete s["f-css"];
  const cap = await captureOutput(FILES, fakeDrive(s));
  assert.equal(cap.rendered_html, HTML);
  assert.match(cap.skipped.find((x) => x.name === "assets/card.css")!.reason, /^fetch_failed/);
});

test("a .dc.html is preferred as the main document over other HTML", async () => {
  const files = [{ name: "other.html", drive_file_id: "a" }, { name: "Main.dc.html", drive_file_id: "b" }];
  const cap = await captureOutput(files, fakeDrive({ a: { mime: "text/html", data: Buffer.from("<p>a</p>") }, b: { mime: "text/html", data: Buffer.from("<p>b</p>") } }));
  assert.equal(cap.rendered_html, "<p>b</p>");
  assert.deepEqual(cap.assets.map((a) => a.name), ["other.html"]);
});

test("loadServiceAccountKey: none, raw JSON, and invalid", () => {
  assert.equal(loadServiceAccountKey({}), null);
  const key = { client_email: "a@b.iam.gserviceaccount.com", private_key: "k" };
  assert.deepEqual(loadServiceAccountKey({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(key) }), key);
  assert.throws(() => loadServiceAccountKey({ GOOGLE_SERVICE_ACCOUNT_JSON: "{}" }), /client_email/);
});

test("DriveClient exchanges a signed JWT once, then downloads with the bearer token", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const calls: { url: string; init?: RequestInit }[] = [];
  const fakeFetch = (async (url: URL | string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    if (u.includes("alt=media")) return new Response(Buffer.from("<p>hi</p>"));
    return new Response(JSON.stringify({ name: "x.dc.html", mimeType: "text/html", size: "9" }));
  }) as typeof fetch;
  const drive = new DriveClient({ client_email: "sa@p.iam.gserviceaccount.com", private_key: privateKey as string }, fakeFetch);

  assert.deepEqual(await drive.meta("id1"), { name: "x.dc.html", mimeType: "text/html", size: 9 });
  assert.equal((await drive.download("id1")).toString(), "<p>hi</p>");

  assert.equal(calls.filter((c) => c.url.includes("oauth2")).length, 1);
  const assertion = new URLSearchParams(String(calls[0].init!.body)).get("assertion")!.split(".");
  assert.equal(assertion.length, 3);
  assert.equal(JSON.parse(Buffer.from(assertion[1], "base64url").toString()).iss, "sa@p.iam.gserviceaccount.com");
  const driveCalls = calls.filter((c) => c.url.includes("/drive/v3/"));
  assert.ok(driveCalls.every((c) => (c.init!.headers as Record<string, string>).Authorization === "Bearer tok"));
  assert.ok(driveCalls.every((c) => c.url.includes("supportsAllDrives=true")));
});
