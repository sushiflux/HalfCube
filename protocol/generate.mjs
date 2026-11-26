#!/usr/bin/env node
// Generates the engine protocol bindings from protocol/engine-protocol.json:
//   app/src/engine/generated/protocol.ts                 TypeScript types, constants and the command -> reply table
//   app/src/document/generated/document-schema.ts        JSON Schema of the stored document as a TypeScript value
//   engine/src/generated/protocol.hpp                    C++ constants, structs, JSON writers and readers
//   protocol/engine-protocol.schema.json                 JSON Schema (draft 2020-12) of every header
//   protocol/document.schema.json                        JSON Schema of the stored document (history.json)
//
//   node protocol/generate.mjs           write the files
//   node protocol/generate.mjs --check   exit 1 when a generated file is missing or differs (for CI)
//
// Source sections: constants, errors (codes of the "error" message), problems (codes of sketch and step problems),
// documentTypes (the stored document), types (shared protocol types), commands, messages.
// A type is either a struct ({ fields }) or a tagged union ({ union: { tag, variants } }) whose variants are struct
// types that carry the tag field as a string const or enum; the tag values of the variants must not overlap.
// Field kinds: string / integer / number / boolean (with enum, const, minimum, maximum, default), array (items),
// map (values, string keys), ref (a struct or union type). optional, nullable and default exclude each other.
//
// No dependencies besides Node itself.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const sourcePath = join(here, "engine-protocol.json");
const sourceRel = "protocol/engine-protocol.json";

const outputs = {
  ts: join(root, "app", "src", "engine", "generated", "protocol.ts"),
  documentSchemaTs: join(root, "app", "src", "document", "generated", "document-schema.ts"),
  hpp: join(root, "engine", "src", "generated", "protocol.hpp"),
  schema: join(here, "engine-protocol.schema.json"),
  documentSchema: join(here, "document.schema.json"),
};

// ------------------------------------------------------------------------------------------ input

function fail(message) {
  console.error(`generate.mjs: ${message}`);
  process.exit(2);
}

let def;
try {
  def = JSON.parse(readFileSync(sourcePath, "utf8"));
} catch (e) {
  fail(`cannot read ${sourceRel}: ${e.message}`);
}

const pascal = (s) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");
const constName = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
const cppConst = (s) => "k" + pascal(s);

const documentTypes = def.documentTypes ?? {};
const protocolTypes = def.types ?? {};
for (const n of Object.keys(documentTypes)) if (protocolTypes[n]) fail(`type "${n}" is defined in documentTypes and in types`);
const types = { ...documentTypes, ...protocolTypes };
const commands = def.commands ?? {};
const messages = def.messages ?? {};
const errorCodes = (def.errors ?? []).map((e) => e.code);
const problemCodes = (def.problems ?? []).map((e) => e.code);
const enumSources = { errors: errorCodes, problems: problemCodes };

const commandTsName = (name) => commands[name].tsName ?? pascal(name) + "Command";
const commandCppName = (name) => commands[name].cppName ?? pascal(name) + "Command";
const messageTsName = (name) => messages[name].tsName ?? pascal(name);
const messageCppName = (name) => messages[name].cppName ?? pascal(name);
const isUnion = (name) => Boolean(types[name]?.union);

/** Tag values of a union variant (a struct type with the tag field as string const or enum). */
function tagValues(variantName, tag) {
  const f = types[variantName]?.fields?.[tag];
  if (!f || f.type !== "string" || (f.const === undefined && !f.enum)) return null;
  return f.const !== undefined ? [f.const] : f.enum;
}

// Basic consistency checks of the definition itself.
function checkField(owner, name, f) {
  const where = `${owner} field "${name}"`;
  if (f.ref) {
    if (!types[f.ref]) fail(`${where}: unknown type "${f.ref}"`);
    return;
  }
  const known = ["string", "integer", "number", "boolean", "array", "map"];
  if (!known.includes(f.type)) fail(`${where}: type must be one of ${known.join(", ")} or a ref`);
  const flags = [f.optional, f.nullable, f.default !== undefined].filter(Boolean).length;
  if (flags > 1) fail(`${where}: optional, nullable and default exclude each other`);
  if (f.default !== undefined && !["string", "integer", "number", "boolean"].includes(f.type)) fail(`${where}: default is only supported on primitive fields`);
  if (f.type === "array") {
    if (!f.items) fail(`${where}: array needs items`);
    checkField(owner, name + "[]", f.items);
  }
  if (f.type === "map") {
    if (!f.values) fail(`${where}: map needs values`);
    checkField(owner, name + "{}", f.values);
  }
  if (f.enumFrom && !enumSources[f.enumFrom]) fail(`${where}: enumFrom supports only ${Object.keys(enumSources).join(", ")}`);
}
for (const [n, t] of Object.entries(types)) {
  if (t.union) {
    if (t.fields) fail(`type ${n}: a union has no fields of its own`);
    const { tag, variants } = t.union;
    if (!tag || !Array.isArray(variants) || variants.length === 0) fail(`type ${n}: union needs tag and variants`);
    const seen = new Map();
    for (const v of variants) {
      if (!types[v] || types[v].union) fail(`type ${n}: variant "${v}" must be a struct type`);
      const values = tagValues(v, tag);
      if (!values) fail(`type ${n}: variant "${v}" needs the field "${tag}" as a string const or enum`);
      for (const value of values) {
        if (seen.has(value)) fail(`type ${n}: tag value "${value}" is used by "${seen.get(value)}" and "${v}"`);
        seen.set(value, v);
      }
    }
    continue;
  }
  for (const [fn, f] of Object.entries(t.fields)) checkField(`type ${n}`, fn, f);
}
for (const [n, c] of Object.entries(commands)) {
  for (const [fn, f] of Object.entries(c.fields)) {
    checkField(`command ${n}`, fn, f);
    if (fn === "type" || fn === "id") fail(`command ${n}: "${fn}" is reserved for the envelope`);
  }
  if (c.reply !== null && !messages[c.reply]) fail(`command ${n}: unknown reply message "${c.reply}"`);
}
for (const [n, m] of Object.entries(messages)) {
  for (const [fn, f] of Object.entries(m.fields)) {
    checkField(`message ${n}`, fn, f);
    if (fn === "type" || fn === "replyTo") fail(`message ${n}: "${fn}" is reserved for the envelope`);
  }
}
if (!messages.error) fail('a message named "error" is required');

/** Type names a field refers to (through arrays and maps). */
function fieldRefs(f) {
  if (f.ref) return [f.ref];
  if (f.type === "array") return fieldRefs(f.items);
  if (f.type === "map") return fieldRefs(f.values);
  return [];
}

/** All types in an order where every type comes after the types it uses (C++ needs complete types). */
function typeOrder() {
  const order = [];
  const state = new Map();
  const visit = (n, chain) => {
    if (state.get(n) === "done") return;
    if (state.get(n) === "visiting") fail(`types refer to each other in a cycle: ${[...chain, n].join(" -> ")}`);
    state.set(n, "visiting");
    const t = types[n];
    const deps = t.union ? t.union.variants : Object.values(t.fields).flatMap(fieldRefs);
    for (const d of deps) visit(d, [...chain, n]);
    state.set(n, "done");
    order.push(n);
  };
  for (const n of Object.keys(types)) visit(n, []);
  return order;
}

const header = `Generated by protocol/generate.mjs from ${sourceRel}. Do not edit; change the source and run "node protocol/generate.mjs".`;

function constValue(c) {
  if (c.type === "string") return JSON.stringify(c.value);
  const v = typeof c.value === "string" ? Number(c.value) : c.value;
  if (!Number.isSafeInteger(v)) fail(`constant ${c.name}: value must be an integer`);
  return v;
}

// ------------------------------------------------------------------------------------------ TypeScript

function tsDoc(doc, indent = "") {
  if (!doc) return "";
  return `${indent}/** ${doc.replace(/\*\//g, "* /")} */\n`;
}

function tsType(f) {
  let t;
  if (f.ref) t = f.ref;
  else if (f.type === "string") {
    if (f.const !== undefined) t = JSON.stringify(f.const);
    else if (f.enum) t = f.enum.map((e) => JSON.stringify(e)).join(" | ");
    else if (f.enumFrom === "errors") t = "ErrorCode";
    else if (f.enumFrom === "problems") t = "StepProblemCode";
    else t = "string";
  } else if (f.type === "integer" || f.type === "number") t = "number";
  else if (f.type === "boolean") t = "boolean";
  else if (f.type === "array") {
    const inner = tsType(f.items);
    t = /[|]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
  } else if (f.type === "map") t = `Record<string, ${tsType(f.values)}>`;
  if (f.nullable) t += " | null";
  return t;
}

function tsFields(fields, indent = "  ") {
  let s = "";
  for (const [name, f] of Object.entries(fields)) {
    const doc = f.default !== undefined ? `${f.doc ? f.doc + " " : ""}Default ${JSON.stringify(f.default)}.` : f.doc;
    s += tsDoc(doc, indent);
    s += `${indent}${name}${f.optional || f.default !== undefined ? "?" : ""}: ${tsType(f)};\n`;
  }
  return s;
}

function tsTypeDecl(name) {
  const t = types[name];
  let s = tsDoc(t.doc);
  if (t.union) return s + `export type ${name} = ${t.union.variants.join(" | ")};\n\n`;
  return s + `export interface ${name} {\n${tsFields(t.fields)}}\n\n`;
}

function generateTs() {
  let s = `// ${header}\n//\n// ${def.protocol.doc}\n\n`;
  s += `/** Protocol version; hello must name exactly this one. */\nexport const PROTOCOL_VERSION = ${def.protocol.version};\n\n`;
  for (const c of def.constants) {
    s += tsDoc(c.doc);
    s += `export const ${constName(c.name)} = ${c.type !== "string" && typeof c.value === "string" ? c.value : constValue(c)};\n`;
  }
  s += `\n/** Error codes of the "error" message. */\nexport const ERROR_CODES = [\n${errorCodes.map((c) => `  ${JSON.stringify(c)},`).join("\n")}\n] as const;\nexport type ErrorCode = (typeof ERROR_CODES)[number];\n\n`;
  s += `/** Codes of sketch and timeline step problems (Problem.code). */\nexport const STEP_PROBLEM_CODES = [\n${problemCodes.map((c) => `  ${JSON.stringify(c)},`).join("\n")}\n] as const;\nexport type StepProblemCode = (typeof STEP_PROBLEM_CODES)[number];\n\n`;

  s += "// ---------------------------------------------------------------- stored document\n\n";
  for (const name of Object.keys(documentTypes)) s += tsTypeDecl(name);
  s += "// ---------------------------------------------------------------- shared types\n\n";
  for (const name of Object.keys(protocolTypes)) s += tsTypeDecl(name);

  s += "// ---------------------------------------------------------------- client -> engine\n\n";
  for (const [name, c] of Object.entries(commands)) {
    s += tsDoc(c.doc + (c.testOnly ? " Only in engines built with test commands." : ""));
    s += `export interface ${commandTsName(name)} {\n  type: ${JSON.stringify(name)};\n  /** Client-chosen request id, 1..MAX_REQUEST_ID, unique per connection. */\n  id: number;\n${tsFields(c.fields)}}\n\n`;
  }
  const cmdNames = Object.keys(commands);
  s += `export type Command =\n${cmdNames.map((n) => `  | ${commandTsName(n)}`).join("\n")};\n`;
  s += `export type CommandType = Command["type"];\n\n`;
  s += `export const COMMAND_TYPES = [\n${cmdNames.map((n) => `  ${JSON.stringify(n)},`).join("\n")}\n] as const;\n`;
  s += `/** Answered at once by the reader, even while another command runs (native engine). */\nexport const IMMEDIATE_COMMAND_TYPES = [\n${cmdNames.filter((n) => commands[n].immediate).map((n) => `  ${JSON.stringify(n)},`).join("\n")}\n] as const;\n`;
  s += `/** Only accepted by engines built with test commands. */\nexport const TEST_COMMAND_TYPES = [\n${cmdNames.filter((n) => commands[n].testOnly).map((n) => `  ${JSON.stringify(n)},`).join("\n")}\n] as const;\n\n`;

  s += "// ---------------------------------------------------------------- engine -> client\n\n";
  for (const [name, m] of Object.entries(messages)) {
    s += tsDoc(m.doc);
    s += `export interface ${messageTsName(name)} {\n  type: ${JSON.stringify(name)};\n  /** Id of the command this answers; null only for errors about unreadable messages. */\n  replyTo: number | null;\n${tsFields(m.fields)}}\n\n`;
  }
  const msgNames = Object.keys(messages);
  s += `export type EngineMessage =\n${msgNames.map((n) => `  | ${messageTsName(n)}`).join("\n")};\n`;
  s += `export type EngineMessageType = EngineMessage["type"];\n\n`;
  s += `/** Successful answer of each command (never = the command does not answer on success). Every command can also answer with ${messageTsName("error")}. */\nexport interface CommandReplies {\n`;
  for (const n of cmdNames) {
    const r = commands[n].reply;
    s += `  ${JSON.stringify(n)}: ${r === null ? "never" : messageTsName(r)};\n`;
  }
  s += `}\n\n`;
  s += `/** Message type of the successful answer of each command (null: the command never answers on success). */\nexport const REPLY_TYPES = {\n`;
  for (const n of cmdNames) {
    const r = commands[n].reply;
    s += `  ${JSON.stringify(n)}: ${r === null ? "null" : JSON.stringify(r)},\n`;
  }
  s += `} as const satisfies Record<CommandType, EngineMessageType | null>;\n`;
  return s;
}

// ------------------------------------------------------------------------------------------ C++

function cppType(f) {
  let t;
  if (f.ref) t = f.ref;
  else if (f.type === "string") t = "std::string";
  else if (f.type === "integer") t = "std::int64_t";
  else if (f.type === "number") t = "double";
  else if (f.type === "boolean") t = "bool";
  else if (f.type === "array") t = `std::vector<${cppType(f.items)}>`;
  else if (f.type === "map") t = `std::map<std::string, ${cppType(f.values)}>`;
  if (f.optional || f.nullable) t = `std::optional<${t}>`;
  return t;
}

function cppDefault(f) {
  if (f.optional || f.nullable) return "";
  if (f.default !== undefined) {
    if (f.type === "string") return ` = ${JSON.stringify(f.default)}`;
    if (f.type === "boolean") return ` = ${f.default ? "true" : "false"}`;
    if (f.type === "number") return ` = ${Number.isInteger(f.default) ? f.default.toFixed(1) : f.default}`;
    return ` = ${f.default}`;
  }
  if (f.type === "string" && f.const !== undefined) return ` = ${JSON.stringify(f.const)}`;
  if (f.type === "integer") return " = 0";
  if (f.type === "number") return " = 0.0";
  if (f.type === "boolean") return " = false";
  return "";
}

function cppDoc(doc, indent) {
  return doc ? `${indent}// ${doc}\n` : "";
}

function cppStructFields(fields, indent = "    ") {
  let s = "";
  for (const [name, f] of Object.entries(fields)) {
    s += cppDoc(f.doc, indent);
    s += `${indent}${cppType(f)} ${name}${cppDefault(f)};\n`;
  }
  return s;
}

function cppWriteFields(typeName, fields) {
  let s = `inline void writeFields(Json& j, const ${typeName}& v) {\n`;
  const entries = Object.entries(fields);
  if (entries.length === 0) s += "    (void)j;\n    (void)v;\n";
  for (const [name, f] of entries) {
    if (f.optional) s += `    if (v.${name}) j["${name}"] = toJsonValue(*v.${name});\n`;
    else if (f.nullable) s += `    j["${name}"] = v.${name} ? toJsonValue(*v.${name}) : Json(nullptr);\n`;
    else s += `    j["${name}"] = toJsonValue(v.${name});\n`;
  }
  return s + "}\n";
}

const cppStringList = (values) => `{${values.map((e) => JSON.stringify(e)).join(", ")}}`;

// C++ statements that read the JSON value `src` into the lvalue `dst`. `path` is a C++ std::string expression naming
// the field (e.g. "document.timeline[1].distance"); depth keeps the loop variables apart.
function cppReadInto(f, src, dst, path, indent, depth = 0) {
  if (f.ref) return `${indent}read(${src}, ${dst}, cmd, ${path});\n`;
  if (f.type === "string") {
    const allowed = f.const !== undefined ? [f.const] : f.enum ?? (f.enumFrom ? enumSources[f.enumFrom] : null);
    if (allowed) return `${indent}${dst} = readEnum(${src}, cmd, ${path}, ${cppStringList(allowed)});\n`;
    return `${indent}${dst} = readString(${src}, cmd, ${path});\n`;
  }
  if (f.type === "integer") {
    const lo = f.minimum ?? "std::numeric_limits<std::int64_t>::min()";
    const hi = f.maximum ?? "std::numeric_limits<std::int64_t>::max()";
    return `${indent}${dst} = readInteger(${src}, cmd, ${path}, ${lo}, ${hi});\n`;
  }
  if (f.type === "number") return `${indent}${dst} = readNumber(${src}, cmd, ${path});\n`;
  if (f.type === "boolean") return `${indent}${dst} = readBool(${src}, cmd, ${path});\n`;
  const i = `i${depth}`;
  if (f.type === "array") {
    let s = `${indent}requireArray(${src}, cmd, ${path});\n${indent}${dst}.clear();\n${indent}${dst}.reserve(${src}.size());\n`;
    s += `${indent}for (std::size_t ${i} = 0; ${i} < ${src}.size(); ++${i}) {\n`;
    s += `${indent}    auto&& e${depth} = ${dst}.emplace_back();\n`;
    s += cppReadInto(f.items, `${src}[${i}]`, `e${depth}`, `${path} + "[" + std::to_string(${i}) + "]"`, indent + "    ", depth + 1);
    s += `${indent}}\n`;
    return s;
  }
  if (f.type === "map") {
    let s = `${indent}requireObject(${src}, cmd, ${path});\n${indent}${dst}.clear();\n`;
    s += `${indent}for (auto ${i} = ${src}.begin(); ${i} != ${src}.end(); ++${i}) {\n`;
    s += `${indent}    auto& e${depth} = ${dst}[${i}.key()];\n`;
    s += cppReadInto(f.values, `${i}.value()`, `e${depth}`, `${path} + "." + ${i}.key()`, indent + "    ", depth + 1);
    s += `${indent}}\n`;
    return s;
  }
  fail(`cannot read field kind ${JSON.stringify(f)}`);
}

// Reading one named member of an object `obj` (a const Json&) into out.<name>; `base` is the C++ path expression of
// the object itself ("" for the fields of a command).
function cppReadMember(name, f, obj, base) {
  const path = base === null ? JSON.stringify(name) : `${base} + ".${name}"`;
  const pathExpr = base === null ? `std::string(${path})` : path;
  let s = `    if (const Json* p = findField(${obj}, "${name}")) {\n`;
  if (f.optional) {
    s += `        out.${name}.emplace();\n`;
    s += cppReadInto({ ...f, optional: false }, "(*p)", `(*out.${name})`, pathExpr, "        ");
  } else if (f.nullable) {
    s += `        if (p->is_null()) out.${name}.reset();\n        else {\n            out.${name}.emplace();\n`;
    s += cppReadInto({ ...f, nullable: false }, "(*p)", `(*out.${name})`, pathExpr, "            ");
    s += `        }\n`;
  } else {
    s += cppReadInto(f, "(*p)", `out.${name}`, pathExpr, "        ");
  }
  s += `    }`;
  if (!f.optional && f.default === undefined) s += ` else {\n        throw FieldError(fieldWhat(cmd, ${pathExpr}) + " is missing.", ${pathExpr});\n    }\n`;
  else s += `\n`;
  return s;
}

function cppTypeReader(name) {
  const t = types[name];
  if (t.union) {
    const { tag, variants } = t.union;
    const all = variants.flatMap((v) => tagValues(v, tag));
    let s = `inline void read(const Json& v, ${name}& out, std::string_view cmd, const std::string& path) {\n`;
    s += `    requireObject(v, cmd, path);\n`;
    s += `    const Json* t = findField(v, "${tag}");\n`;
    s += `    if (!t) throw FieldError(fieldWhat(cmd, path + ".${tag}") + " is missing.", path + ".${tag}");\n`;
    s += `    const std::string tag = readEnum(*t, cmd, path + ".${tag}", ${cppStringList(all)});\n`;
    for (const variant of variants) {
      const cond = tagValues(variant, tag).map((value) => `tag == ${JSON.stringify(value)}`).join(" || ");
      s += `    if (${cond}) {\n        ${variant} x;\n        read(v, x, cmd, path);\n        out = std::move(x);\n        return;\n    }\n`;
    }
    s += `}\n\n`;
    return s;
  }
  const names = Object.keys(t.fields);
  let s = `inline void read(const Json& v, ${name}& out, std::string_view cmd, const std::string& path) {\n`;
  s += `    requireObject(v, cmd, path);\n`;
  s += `    rejectUnknownMembers(v, cmd, path, ${cppStringList(names)});\n`;
  if (names.length === 0) s += "    (void)out;\n";
  for (const [fn, f] of Object.entries(t.fields)) s += cppReadMember(fn, f, "v", "path");
  s += `}\n\n`;
  return s;
}

function generateHpp() {
  const order = typeOrder();
  const structNames = order.filter((n) => !isUnion(n));
  let s = `// ${header}\n//\n// ${def.protocol.doc}\n#pragma once\n\n`;
  s += `#include <nlohmann/json.hpp>\n\n#include <cmath>\n#include <cstddef>\n#include <cstdint>\n#include <initializer_list>\n#include <limits>\n#include <map>\n#include <optional>\n#include <stdexcept>\n#include <string>\n#include <string_view>\n#include <utility>\n#include <variant>\n#include <vector>\n\n`;
  s += `namespace hc::protocol {\n\nusing Json = nlohmann::ordered_json;\n\n`;
  s += `// Protocol version; hello must name exactly this one.\ninline constexpr int kVersion = ${def.protocol.version};\n\n`;
  for (const c of def.constants) {
    s += cppDoc(c.doc, "");
    if (c.type === "string") s += `inline constexpr std::string_view ${cppConst(c.name)} = ${constValue(c)};\n`;
    else if (c.type === "u32") s += `inline constexpr std::uint32_t ${cppConst(c.name)} = ${typeof c.value === "string" ? c.value : constValue(c)}u;\n`;
    else s += `inline constexpr std::int64_t ${cppConst(c.name)} = ${constValue(c)};\n`;
  }
  s += `\n// Error codes of the "error" message.\nnamespace err {\n`;
  for (const e of def.errors) s += cppDoc(e.doc, "") + `inline constexpr const char* ${cppConst(e.code)} = ${JSON.stringify(e.code)};\n`;
  s += `} // namespace err\n\n`;
  s += `// Codes of sketch and timeline step problems (Problem.code).\nnamespace problem {\n`;
  for (const e of def.problems ?? []) s += cppDoc(e.doc, "") + `inline constexpr const char* ${cppConst(e.code)} = ${JSON.stringify(e.code)};\n`;
  s += `} // namespace problem\n\n`;
  s += `// Command types.\nnamespace cmd {\n`;
  for (const n of Object.keys(commands)) s += `inline constexpr const char* ${cppConst(n)} = ${JSON.stringify(n)};\n`;
  s += `} // namespace cmd\n\n`;
  s += `// Engine message types.\nnamespace msg {\n`;
  for (const n of Object.keys(messages)) s += `inline constexpr const char* ${cppConst(n)} = ${JSON.stringify(n)};\n`;
  s += `} // namespace msg\n\n`;

  s += `struct CommandInfo {\n    const char* type;\n    bool immediate;  // answered at once by the reader, also while another command runs\n    bool testOnly;   // only in builds with test commands\n    const char* reply;  // type of the success answer, nullptr = none\n};\n\n`;
  s += `inline constexpr CommandInfo kCommands[] = {\n`;
  for (const [n, c] of Object.entries(commands)) {
    s += `    {${JSON.stringify(n)}, ${c.immediate ? "true" : "false"}, ${c.testOnly ? "true" : "false"}, ${c.reply === null ? "nullptr" : JSON.stringify(c.reply)}},\n`;
  }
  s += `};\n\n`;

  s += `// ---------------------------------------------------------------- stored document and shared types\n\n`;
  for (const name of order) {
    const t = types[name];
    s += cppDoc(t.doc, "");
    if (t.union) s += `using ${name} = std::variant<${t.union.variants.join(", ")}>;\n\n`;
    else s += `struct ${name} {\n${cppStructFields(t.fields)}};\n\n`;
  }
  s += `// ---------------------------------------------------------------- commands (fields without the envelope)\n\n`;
  for (const [name, c] of Object.entries(commands)) {
    s += cppDoc(c.doc, "");
    s += `struct ${commandCppName(name)} {\n    static constexpr std::string_view kType = ${JSON.stringify(name)};\n    static constexpr bool kImmediate = ${c.immediate ? "true" : "false"};\n    static constexpr bool kTestOnly = ${c.testOnly ? "true" : "false"};\n${cppStructFields(c.fields)}};\n\n`;
  }
  s += `// ---------------------------------------------------------------- engine messages (fields without the envelope)\n\n`;
  for (const [name, m] of Object.entries(messages)) {
    s += cppDoc(m.doc, "");
    s += `struct ${messageCppName(name)} {\n    static constexpr std::string_view kType = ${JSON.stringify(name)};\n${cppStructFields(m.fields)}};\n\n`;
  }

  s += `// ---------------------------------------------------------------- JSON writers\n\n`;
  s += `inline Json toJsonValue(const std::string& v) { return Json(v); }\ninline Json toJsonValue(std::int64_t v) { return Json(v); }\ninline Json toJsonValue(double v) { return Json(v); }\ninline Json toJsonValue(bool v) { return Json(v); }\n`;
  for (const name of structNames) s += `inline Json toJsonValue(const ${name}& v);\n`;
  s += `template <class T>\nJson toJsonValue(const std::vector<T>& v);\ntemplate <class T>\nJson toJsonValue(const std::map<std::string, T>& v);\ntemplate <class... T>\nJson toJsonValue(const std::variant<T...>& v);\n`;
  s += `template <class T>\nJson toJsonValue(const std::vector<T>& v) {\n    Json a = Json::array();\n    for (const auto& e : v) a.push_back(toJsonValue(e));\n    return a;\n}\n`;
  s += `template <class T>\nJson toJsonValue(const std::map<std::string, T>& v) {\n    Json o = Json::object();\n    for (const auto& [k, e] : v) o[k] = toJsonValue(e);\n    return o;\n}\n`;
  s += `template <class... T>\nJson toJsonValue(const std::variant<T...>& v) {\n    return std::visit([](const auto& x) { return toJsonValue(x); }, v);\n}\n\n`;
  for (const name of structNames) {
    s += cppWriteFields(name, types[name].fields);
    s += `inline Json toJsonValue(const ${name}& v) {\n    Json j = Json::object();\n    writeFields(j, v);\n    return j;\n}\n\n`;
  }
  for (const [name, m] of Object.entries(messages)) s += cppWriteFields(messageCppName(name), m.fields) + "\n";
  s += `// Complete header of an engine message: type, replyTo (null when absent), then the fields.\ntemplate <class Message>\nJson messageJson(const Message& m, std::optional<std::int64_t> replyTo) {\n    Json j = Json::object();\n    j["type"] = std::string(Message::kType);\n    j["replyTo"] = replyTo ? Json(*replyTo) : Json(nullptr);\n    writeFields(j, m);\n    return j;\n}\n\n`;

  s += `// ---------------------------------------------------------------- readers\n\n`;
  s += `// Thrown by the readers with a complete message that names the command and the path of the field, e.g.\n// Command "model.sync": field "document.timeline[1].distance.value" must be a finite number, got "x".\nclass FieldError : public std::runtime_error {\npublic:\n    explicit FieldError(const std::string& message, std::string path = {}) : std::runtime_error(message), path_(std::move(path)) {}\n    // Path of the field inside the command ("document.timeline[1].distance.value"); empty for the envelope.\n    const std::string& path() const noexcept { return path_; }\n\nprivate:\n    std::string path_;\n};\n\n`;
  s += `// An empty command names a field of the message envelope (id, type).\ninline std::string fieldWhat(std::string_view command, const std::string& path) {\n    if (command.empty()) return "The message field \\"" + path + "\\"";\n    return "Command \\"" + std::string(command) + "\\": field \\"" + path + "\\"";\n}\n\n`;
  s += `inline const Json* findField(const Json& j, const char* name) {\n    const auto it = j.find(name);\n    return it == j.end() ? nullptr : &*it;\n}\n\n`;
  s += `inline std::string describeJson(const Json& v) {\n    std::string s = v.dump();\n    if (s.size() > 80) s = s.substr(0, 77) + "...";\n    return s;\n}\n\n`;
  s += `inline void requireObject(const Json& v, std::string_view cmd, const std::string& path) {\n    if (!v.is_object()) throw FieldError(fieldWhat(cmd, path) + " must be an object, got " + describeJson(v) + ".", path);\n}\n\n`;
  s += `inline void requireArray(const Json& v, std::string_view cmd, const std::string& path) {\n    if (!v.is_array()) throw FieldError(fieldWhat(cmd, path) + " must be an array, got " + describeJson(v) + ".", path);\n}\n\n`;
  s += `inline std::string readString(const Json& v, std::string_view cmd, const std::string& path) {\n    if (!v.is_string()) throw FieldError(fieldWhat(cmd, path) + " must be a string, got " + describeJson(v) + ".", path);\n    return v.get<std::string>();\n}\n\n`;
  s += `inline std::string readEnum(const Json& v, std::string_view cmd, const std::string& path, std::initializer_list<const char*> allowed) {\n    if (v.is_string()) {\n        const std::string s = v.get<std::string>();\n        for (const char* a : allowed)\n            if (s == a) return s;\n    }\n    std::string list;\n    for (const char* a : allowed) list += (list.empty() ? "\\"" : ", \\"") + std::string(a) + "\\"";\n    throw FieldError(fieldWhat(cmd, path) + (allowed.size() == 1 ? " must be " : " must be one of ") + list + ", got " + describeJson(v) + ".", path);\n}\n\n`;
  s += `// JSON numbers from JavaScript are doubles: an integral double is accepted as an integer.\ninline std::int64_t readInteger(const Json& v, std::string_view cmd, const std::string& path, std::int64_t lo, std::int64_t hi) {\n    const auto bad = [&] {\n        return FieldError(fieldWhat(cmd, path) + " must be an integer from " + std::to_string(lo) + " to " + std::to_string(hi) + ", got " + describeJson(v) + ".", path);\n    };\n    if (v.is_number_integer()) {\n        if (v.is_number_unsigned() && v.get<std::uint64_t>() > static_cast<std::uint64_t>(hi)) throw bad();\n        const std::int64_t i = v.get<std::int64_t>();\n        if (i < lo || i > hi) throw bad();\n        return i;\n    }\n    if (v.is_number_float()) {\n        const double d = v.get<double>();\n        if (std::isfinite(d) && d == std::floor(d) && d >= static_cast<double>(lo) && d <= static_cast<double>(hi)) return static_cast<std::int64_t>(d);\n    }\n    throw bad();\n}\n\n`;
  s += `inline double readNumber(const Json& v, std::string_view cmd, const std::string& path) {\n    if (!v.is_number() || !std::isfinite(v.get<double>())) throw FieldError(fieldWhat(cmd, path) + " must be a finite number, got " + describeJson(v) + ".", path);\n    return v.get<double>();\n}\n\n`;
  s += `inline bool readBool(const Json& v, std::string_view cmd, const std::string& path) {\n    if (!v.is_boolean()) throw FieldError(fieldWhat(cmd, path) + " must be true or false, got " + describeJson(v) + ".", path);\n    return v.get<bool>();\n}\n\n`;
  s += `inline std::string quotedList(std::initializer_list<const char*> names) {\n    std::string list;\n    for (const char* k : names) list += (list.empty() ? "\\"" : ", \\"") + std::string(k) + "\\"";\n    return list;\n}\n\n`;
  s += `// Members other than the listed ones are refused, so typing errors do not pass silently.\ninline void rejectUnknownMembers(const Json& j, std::string_view cmd, const std::string& path, std::initializer_list<const char*> known) {\n    for (auto it = j.begin(); it != j.end(); ++it) {\n        bool ok = false;\n        for (const char* k : known) ok = ok || it.key() == k;\n        if (!ok) throw FieldError(fieldWhat(cmd, path) + " has no member \\"" + it.key() + "\\"; its members are " + quotedList(known) + ".", path + "." + it.key());\n    }\n}\n\n`;
  s += `// Fields other than the envelope (type, id) and the listed ones are refused, so typing errors do not pass silently.\ninline void rejectUnknownFields(const Json& j, std::string_view command, std::initializer_list<const char*> known) {\n    for (auto it = j.begin(); it != j.end(); ++it) {\n        if (it.key() == "type" || it.key() == "id") continue;\n        bool ok = false;\n        for (const char* k : known) ok = ok || it.key() == k;\n        if (!ok) {\n            throw FieldError("Command \\"" + std::string(command) + "\\" has no field \\"" + it.key() + "\\"" +\n                                 (known.size() == 0 ? std::string(" (it takes no fields).") : "; its fields are " + quotedList(known) + "."),\n                             it.key());\n        }\n    }\n}\n\n`;
  for (const name of order) s += `inline void read(const Json& v, ${name}& out, std::string_view cmd, const std::string& path);\n`;
  s += `\n`;
  for (const name of order) s += cppTypeReader(name);

  s += `// ---------------------------------------------------------------- command parsers\n\n`;
  for (const [name, c] of Object.entries(commands)) {
    const cn = commandCppName(name);
    const fieldNames = Object.keys(c.fields);
    s += `inline void parse(const Json& j, ${cn}& out) {\n`;
    s += `    constexpr std::string_view cmd = ${cn}::kType;\n`;
    s += `    rejectUnknownFields(j, cmd, ${cppStringList(fieldNames)});\n`;
    if (fieldNames.length === 0) s += "    (void)out;\n";
    for (const [fn, f] of Object.entries(c.fields)) s += cppReadMember(fn, f, "j", null);
    s += `}\n\n`;
  }
  s += `// Parses the fields of a command of the given type (throws FieldError). Returns false for an unknown type.\ninline bool validateCommand(std::string_view type, const Json& j) {\n`;
  for (const name of Object.keys(commands)) {
    s += `    if (type == ${commandCppName(name)}::kType) {\n        ${commandCppName(name)} c;\n        parse(j, c);\n        return true;\n    }\n`;
  }
  s += `    return false;\n}\n\n`;
  s += `} // namespace hc::protocol\n`;
  return s;
}

// ------------------------------------------------------------------------------------------ JSON Schema

function schemaField(f) {
  let s;
  if (f.ref) s = { $ref: `#/$defs/${f.ref}` };
  else if (f.type === "string") {
    s = { type: "string" };
    if (f.const !== undefined) s.const = f.const;
    if (f.enum) s.enum = f.enum;
    if (f.enumFrom) s.enum = enumSources[f.enumFrom];
  } else if (f.type === "integer" || f.type === "number") {
    s = { type: f.type };
    if (f.minimum !== undefined) s.minimum = f.minimum;
    if (f.maximum !== undefined) s.maximum = f.maximum;
  } else if (f.type === "boolean") s = { type: "boolean" };
  else if (f.type === "array") s = { type: "array", items: schemaField(f.items) };
  else if (f.type === "map") s = { type: "object", additionalProperties: schemaField(f.values) };
  if (f.default !== undefined) s.default = f.default;
  if (f.nullable) s = { oneOf: [s, { type: "null" }] };
  if (f.doc) s = { description: f.doc, ...s };
  return s;
}

function schemaObject(doc, envelope, fields) {
  const properties = { ...envelope };
  const required = Object.keys(envelope);
  for (const [n, f] of Object.entries(fields)) {
    properties[n] = schemaField(f);
    if (!f.optional && f.default === undefined) required.push(n);
  }
  const o = { type: "object", additionalProperties: false, required, properties };
  return doc ? { description: doc, ...o } : o;
}

function schemaType(name) {
  const t = types[name];
  if (t.union) {
    const o = { oneOf: t.union.variants.map((v) => ({ $ref: `#/$defs/${v}` })) };
    return t.doc ? { description: t.doc, ...o } : o;
  }
  return schemaObject(t.doc, {}, t.fields);
}

function generateSchema() {
  const defs = {
    requestId: { type: "integer", minimum: 1, maximum: Number(def.constants.find((c) => c.name === "maxRequestId").value) },
  };
  for (const n of Object.keys(types)) defs[n] = schemaType(n);
  for (const [n, c] of Object.entries(commands)) {
    defs[commandTsName(n)] = schemaObject(c.doc, { type: { const: n }, id: { $ref: "#/$defs/requestId" } }, c.fields);
  }
  for (const [n, m] of Object.entries(messages)) {
    defs[messageTsName(n)] = schemaObject(m.doc, { type: { const: n }, replyTo: { oneOf: [{ $ref: "#/$defs/requestId" }, { type: "null" }] } }, m.fields);
  }
  defs.command = { oneOf: Object.keys(commands).map((n) => ({ $ref: `#/$defs/${commandTsName(n)}` })) };
  defs.engineMessage = { oneOf: Object.keys(messages).map((n) => ({ $ref: `#/$defs/${messageTsName(n)}` })) };
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:halfcube:engine-protocol:${def.protocol.version}`,
    title: `HalfCube engine message protocol, version ${def.protocol.version}`,
    description: `${header} Entry points: #/$defs/command and #/$defs/engineMessage. ${def.protocol.doc}`,
    $defs: defs,
  };
  return JSON.stringify(schema, null, 2) + "\n";
}

function documentSchemaObject() {
  const defs = {};
  for (const n of Object.keys(documentTypes)) defs[n] = schemaType(n);
  const format = def.constants.find((c) => c.name === "documentFormat")?.value ?? 1;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:halfcube:document:${format}`,
    title: `HalfCube document, format ${format}`,
    description: `${header} The stored HalfCube document (history.json inside a .hcube file). ${def.$commentDocument ?? ""}`.trim(),
    $ref: "#/$defs/HalfCubeDocument",
    $defs: defs,
  };
}

function generateDocumentSchema() {
  return JSON.stringify(documentSchemaObject(), null, 2) + "\n";
}

function generateDocumentSchemaTs() {
  let s = `// ${header}\n//\n// JSON Schema of the stored HalfCube document (the same as protocol/document.schema.json), for the document\n// store's checks in the app.\n\n`;
  s += `export const DOCUMENT_SCHEMA = ${JSON.stringify(documentSchemaObject(), null, 2)} as const;\n`;
  return s;
}

// ------------------------------------------------------------------------------------------ write or check

const generated = [
  [outputs.ts, generateTs()],
  [outputs.documentSchemaTs, generateDocumentSchemaTs()],
  [outputs.hpp, generateHpp()],
  [outputs.schema, generateSchema()],
  [outputs.documentSchema, generateDocumentSchema()],
];

const check = process.argv.includes("--check");
let stale = 0;
for (const [path, text] of generated) {
  const rel = relative(root, path).replace(/\\/g, "/");
  if (check) {
    const have = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null;
    if (have !== text) {
      console.error(`stale: ${rel} ${have === null ? "(missing)" : "(differs from the source)"}`);
      stale++;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    console.log(`wrote ${rel}`);
  }
}
if (check) {
  if (stale) {
    console.error(`${stale} generated file(s) are stale. Run: node protocol/generate.mjs`);
    process.exit(1);
  }
  console.log("generated protocol files are up to date");
}
