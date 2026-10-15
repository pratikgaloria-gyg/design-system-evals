/**
 * Builds scorers/tokens.manifest.json from a local compass checkout.
 *   npm run build:tokens -- <path-to-compass-repo> [out-file]
 * The output is committed so the pushed Braintrust scorer can import it. Re-run and commit when compass tokens change.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildCompassManifest } from "./compassRepo.js";
import { parseManifest } from "../scorers/tokenManifest.js";

const [repoArg, outArg] = process.argv.slice(2);
if (!repoArg) { console.error("usage: npm run build:tokens -- <path-to-compass-repo> [out-file]"); process.exit(1); }
const root = resolve(repoArg);
const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const manifest = parseManifest(buildCompassManifest(root, { sha }));
const out = resolve(outArg ?? "scorers/tokens.manifest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
const byCat = manifest.tokens.reduce<Record<string, number>>((m, t) => ((m[t.category] = (m[t.category] ?? 0) + 1), m), {});
console.log(`${out}: ${manifest.version}, tokens ${JSON.stringify(byCat)}, styles ${manifest.styles.length}`);
