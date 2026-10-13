/**
 * Minimal Google Drive v3 client for reading session outputs (UDS-525).
 * Service-account auth (RS256 JWT -> access token), read-only scope, zero dependencies.
 *
 * Credentials, first match wins:
 *   GOOGLE_SERVICE_ACCOUNT_JSON      raw key JSON (CI secret)
 *   GOOGLE_APPLICATION_CREDENTIALS   path to the key JSON file (local .env)
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

export interface DriveFileMeta { name: string; mimeType: string; size: number | null }

/** What output capture needs from Drive. Tests pass a fake. */
export interface DriveSource {
  meta(fileId: string): Promise<DriveFileMeta>;
  download(fileId: string): Promise<Buffer>;
}

interface ServiceAccountKey { client_email: string; private_key: string; token_uri?: string }

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const API = "https://www.googleapis.com/drive/v3";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function loadServiceAccountKey(env: NodeJS.ProcessEnv = process.env): ServiceAccountKey | null {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const path = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!raw && !path) return null;
  const key = JSON.parse(raw || readFileSync(path!, "utf8")) as ServiceAccountKey;
  if (!key.client_email || !key.private_key) throw new Error("Service account key is missing client_email or private_key");
  return key;
}

export class DriveClient implements DriveSource {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private key: ServiceAccountKey, private fetchImpl: typeof fetch = fetch) {}

  /** null when no credentials are configured (output capture is then skipped, not fatal). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): DriveClient | null {
    const key = loadServiceAccountKey(env);
    return key ? new DriveClient(key) : null;
  }

  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt - 60 > now) return this.token.value;
    const aud = this.key.token_uri ?? DEFAULT_TOKEN_URI;
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: this.key.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 }));
    const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(this.key.private_key);
    const r = await this.fetchImpl(aud, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${b64url(sig)}` }),
    });
    if (!r.ok) throw new Error(`Google token ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const d = (await r.json()) as { access_token: string; expires_in: number };
    this.token = { value: d.access_token, expiresAt: now + d.expires_in };
    return d.access_token;
  }

  private async get(path: string, params: Record<string, string>): Promise<Response> {
    const url = new URL(`${API}${path}`);
    url.searchParams.set("supportsAllDrives", "true");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    if (!r.ok) throw new Error(`Drive ${r.status} ${path}: ${(await r.text()).slice(0, 300)}`);
    return r;
  }

  async meta(fileId: string): Promise<DriveFileMeta> {
    const d = (await (await this.get(`/files/${encodeURIComponent(fileId)}`, { fields: "name,mimeType,size" })).json()) as
      { name: string; mimeType: string; size?: string };
    return { name: d.name, mimeType: d.mimeType, size: d.size !== undefined ? Number(d.size) : null };
  }

  async download(fileId: string): Promise<Buffer> {
    return Buffer.from(await (await this.get(`/files/${encodeURIComponent(fileId)}`, { alt: "media" })).arrayBuffer());
  }
}
