// Checks a document against its JSON Schema (generated from the protocol source) and writes it with a fixed key
// order (the order of the type description), so the same document always gives the same text: stable files,
// readable diffs, and an engine cache key that does not depend on how an object was built.
import { DOCUMENT_SCHEMA } from "./generated/document-schema.ts";
import type { HalfCubeDocument } from "./types.ts";

interface Schema {
  $ref?: string;
  oneOf?: readonly Schema[];
  const?: unknown;
  enum?: readonly unknown[];
  type?: string;
  minimum?: number;
  maximum?: number;
  items?: Schema;
  required?: readonly string[];
  properties?: Readonly<Record<string, Schema>>;
  additionalProperties?: boolean | Schema;
}

const DEFS = (DOCUMENT_SCHEMA as unknown as { $defs: Record<string, Schema> }).$defs;
const ROOT: Schema = { $ref: "#/$defs/HalfCubeDocument" };

function resolve(schema: Schema): Schema {
  let s = schema;
  while (s.$ref) {
    const def = DEFS[s.$ref.replace("#/$defs/", "")];
    if (!def) throw new Error(`The document schema has no definition ${s.$ref}.`);
    s = def;
  }
  return s;
}

function typeOf(value: unknown): string {
  return Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}

function check(value: unknown, schema: Schema, path: string, out: string[]): void {
  const s = resolve(schema);
  if (s.oneOf) {
    const matching = s.oneOf.filter((alt) => {
      const e: string[] = [];
      check(value, alt, path, e);
      return e.length === 0;
    });
    if (matching.length === 1) return;
    if (matching.length === 0) {
      // Report the errors of the variant the value means: the one whose tag (a const field) it carries.
      const tagged = s.oneOf.filter((alt) => {
        const r = resolve(alt);
        const obj = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
        return Object.entries(r.properties ?? {}).some(([k, p]) => p.const !== undefined && obj[k] === p.const);
      });
      const meant = tagged.length === 1 ? tagged[0] : s.oneOf.length === 1 ? s.oneOf[0] : undefined;
      if (meant) {
        check(value, meant, path, out);
        return;
      }
    }
    out.push(`${path} matches ${matching.length} of the ${s.oneOf.length} allowed forms.`);
    return;
  }
  if (s.type) {
    const actual = typeOf(value);
    const ok =
      s.type === actual ||
      (s.type === "integer" && Number.isInteger(value)) ||
      (s.type === "number" && actual === "number" && Number.isFinite(value));
    if (!ok) {
      out.push(`${path} must be ${s.type === "integer" ? "an integer" : `of type ${s.type}`}, got ${JSON.stringify(value) ?? actual}.`);
      return;
    }
  }
  if (s.const !== undefined && value !== s.const) out.push(`${path} must be ${JSON.stringify(s.const)}, got ${JSON.stringify(value)}.`);
  if (s.enum && !s.enum.includes(value)) out.push(`${path} must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}, got ${JSON.stringify(value)}.`);
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) out.push(`${path} must be at least ${s.minimum}, got ${value}.`);
    if (s.maximum !== undefined && value > s.maximum) out.push(`${path} must be at most ${s.maximum}, got ${value}.`);
  }
  if (Array.isArray(value) && s.items) value.forEach((v, i) => check(v, s.items!, `${path}[${i}]`, out));
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in obj) || obj[r] === undefined) out.push(`${path}.${r} is missing.`);
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const known = s.properties?.[k];
      if (known) check(v, known, `${path}.${k}`, out);
      else if (s.additionalProperties === false) out.push(`${path}.${k} is not a field of this object.`);
    }
  }
}

/** Every schema violation of the document with its path ("document.timeline[1].distance.value ..."); empty = valid. */
export function documentProblems(doc: unknown): string[] {
  const out: string[] = [];
  check(doc, ROOT, "document", out);
  return out;
}

/** Throws with all violations when the document does not match the schema. */
export function assertValidDocument(doc: unknown): asserts doc is HalfCubeDocument {
  const problems = documentProblems(doc);
  if (problems.length) {
    throw new Error(`The document is not valid (${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems.join(" ")}`);
  }
}

function canonical(value: unknown, schema: Schema): unknown {
  const s = resolve(schema);
  if (s.oneOf) {
    const alt = s.oneOf.find((a) => {
      const e: string[] = [];
      check(value, a, "", e);
      return e.length === 0;
    });
    return alt ? canonical(value, alt) : value;
  }
  if (Array.isArray(value)) return s.items ? value.map((v) => canonical(v, s.items!)) : value;
  if (value !== null && typeof value === "object" && s.properties) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries(s.properties)) if (obj[k] !== undefined) out[k] = canonical(obj[k], sub);
    for (const [k, v] of Object.entries(obj)) if (!(k in out) && v !== undefined) out[k] = v;
    return out;
  }
  return value;
}

/** The document with its keys in the order of the type description (a new object; the input is not changed). */
export function canonicalDocument(doc: HalfCubeDocument): HalfCubeDocument {
  return canonical(doc, ROOT) as HalfCubeDocument;
}

/** JSON text of the document with the fixed key order (history.json, autosave). */
export function serializeDocument(doc: HalfCubeDocument, indent = 2): string {
  return JSON.stringify(canonicalDocument(doc), null, indent);
}
