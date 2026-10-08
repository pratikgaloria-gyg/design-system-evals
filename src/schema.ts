/**
 * Tiny JSON-Schema validator covering the subset used by schema/trace.schema.json
 * (type, required, properties, items, enum, minimum, minLength). Zero dependencies.
 * Swap in ajv if the schema ever outgrows this.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(here, "..", "schema", "trace.schema.json");
export const SCHEMA_VERSION = "0.4";

type Schema = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  minLength?: number;
};

export function loadSchema(): Schema {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeOk(v: unknown, t: string | string[]): boolean {
  const actual = typeOf(v);
  return ([] as string[]).concat(t).some((x) => x === actual || (x === "number" && actual === "integer"));
}

export function validateAgainst(schema: Schema, value: unknown, path = ""): string[] {
  const errs: string[] = [];
  const at = path || "<root>";
  if (schema.type && !typeOk(value, schema.type)) {
    errs.push(`${at}: expected ${([] as string[]).concat(schema.type).join("|")}, got ${typeOf(value)}`);
    return errs;
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) errs.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) errs.push(`${at}: ${value} < ${schema.minimum}`);
  if (schema.minLength !== undefined && typeof value === "string" && value.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in obj)) errs.push(`${at}: missing required '${r}'`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (k in obj) errs.push(...validateAgainst(sub, obj[k], path ? `${path}/${k}` : k));
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => errs.push(...validateAgainst(schema.items!, item, `${path}/${i}`)));
  return errs;
}

/** Human-readable schema violations; empty array when valid. */
export function validate(value: unknown): string[] {
  return validateAgainst(loadSchema(), value).sort();
}
