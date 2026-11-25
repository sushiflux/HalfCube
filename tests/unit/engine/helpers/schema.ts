// Minimal JSON Schema check against protocol/engine-protocol.schema.json (generated from the single protocol source),
// enough for the keywords the generator emits: $ref, oneOf, const, enum, type, minimum, maximum, items, required,
// properties, additionalProperties. No dependency; the contract tests use it to check every message the engine sends
// and every command the client sends.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../../../config/build-info.ts";

interface Schema {
  $ref?: string;
  oneOf?: Schema[];
  const?: unknown;
  enum?: unknown[];
  type?: string;
  minimum?: number;
  maximum?: number;
  items?: Schema;
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
}

const root = JSON.parse(readFileSync(join(repoRoot, "protocol", "engine-protocol.schema.json"), "utf8")) as {
  $defs: Record<string, Schema>;
};

function check(value: unknown, schema: Schema, path: string): string[] {
  if (schema.$ref) {
    const def = root.$defs[schema.$ref.replace("#/$defs/", "")];
    if (!def) return [`${path}: unknown schema ${schema.$ref}`];
    return check(value, def, path);
  }
  if (schema.oneOf) {
    const matching = schema.oneOf.filter((alt) => check(value, alt, path).length === 0).length;
    return matching === 1 ? [] : [`${path}: matches ${matching} of ${schema.oneOf.length} alternatives`];
  }
  const errors: string[] = [];
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (schema.type) {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const ok = schema.type === actual || (schema.type === "integer" && Number.isInteger(value)) || (schema.type === "number" && actual === "number");
    if (!ok) return [`${path}: expected ${schema.type}, got ${actual}`];
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > ${schema.maximum}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errors.push(...check(v, schema.items!, `${path}[${i}]`)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in obj)) errors.push(`${path}: missing ${r}`);
    for (const [k, v] of Object.entries(obj)) {
      const known = schema.properties?.[k];
      if (known) errors.push(...check(v, known, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected field ${k}`);
      else if (typeof schema.additionalProperties === "object") errors.push(...check(v, schema.additionalProperties, `${path}.${k}`));
    }
  }
  return errors;
}

/** Problems of an engine message against the schema; an empty list means it is valid. */
export const engineMessageProblems = (message: unknown): string[] => check(message, { $ref: "#/$defs/engineMessage" }, "$");

/** Problems of a command against the schema; an empty list means it is valid. */
export const commandProblems = (command: unknown): string[] => check(command, { $ref: "#/$defs/command" }, "$");
