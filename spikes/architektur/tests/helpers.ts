// Shared test setup: engine locations, client factories with schema validation, mesh checks.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { EngineClient } from "../client/engine-client.ts";
import { NativeTransport } from "../client/native-transport.ts";
import { nodeWorkerPort } from "../client/node-worker-port.ts";
import { WorkerTransport } from "../client/worker-transport.ts";
import type { EngineTransport, ExitInfo } from "../client/transport.ts";
import { meshViews } from "../protocol/mesh.ts";
import type { BodyResult, EngineMessage, Recipe } from "../protocol/protocol.ts";

export const root = new URL("../", import.meta.url);
const fromRoot = (p: string) => fileURLToPath(new URL(p, root));

/** Native engine; override with PC_ENGINE_EXE. */
export const engineExe = process.env.PC_ENGINE_EXE ?? fromRoot("_build/engine-win/partcraft-engine.exe");
/** WebAssembly engine module; override with PC_ENGINE_WASM (path of partcraft-engine.mjs). */
export const engineWasm = process.env.PC_ENGINE_WASM ?? fromRoot("_build/engine-wasm/partcraft-engine.mjs");
export const workerScript = new URL("client/engine-worker.mjs", root);

export type Kind = "native" | "wasm";
export const kinds: Kind[] = ["native", "wasm"];

export function missingBuild(kind: Kind): string | false {
  const p = kind === "native" ? engineExe : engineWasm;
  return existsSync(p) ? false : `${kind} engine not built (${p})`;
}

export function loadRecipe(name: string): Recipe {
  return JSON.parse(readFileSync(fromRoot(`recipes/${name}.json`), "utf8")) as Recipe;
}

const schema = JSON.parse(readFileSync(fromRoot("protocol/protocol.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema, "protocol");
export const validateEngineMessage = ajv.getSchema("protocol#/$defs/engineMessage")!;
export const validateCommand = ajv.getSchema("protocol#/$defs/command")!;
export const validateRecipe = ajv.getSchema("protocol#/$defs/recipe")!;

export function transportFor(kind: Kind, opts: { debug?: boolean; sharedCancel?: boolean } = {}): EngineTransport {
  const debug = opts.debug ?? true;
  if (kind === "native") return new NativeTransport({ exe: engineExe, args: debug ? ["--debug-commands"] : [] });
  return new WorkerTransport({
    createPort: () => nodeWorkerPort(workerScript),
    moduleUrl: pathToFileURL(engineWasm).href,
    debugCommands: debug,
    sharedCancel: opts.sharedCancel ?? true,
  });
}

/** Wraps a transport so every outgoing header is checked against the command schema. */
function checkingTransport(t: EngineTransport, errors: string[], skip: { on: boolean }): EngineTransport {
  const send = t.send.bind(t);
  t.send = (header, payload) => {
    const cmd = JSON.parse(header);
    if (!skip.on && !validateCommand(cmd)) errors.push(`command ${header.slice(0, 200)}: ${JSON.stringify(validateCommand.errors)}`);
    send(header, payload);
  };
  return t;
}

export interface TestClient {
  client: EngineClient;
  /** Schema violations seen so far (engine messages and commands). Tests assert it stays empty. */
  schemaErrors: string[];
  crashes: ExitInfo[];
  unsolicited: EngineMessage[];
  /** Runs fn (which must send synchronously) without the command schema check, for deliberately invalid commands. */
  unchecked<T>(fn: () => T): T;
}

export async function startClient(kind: Kind, opts: { debug?: boolean; sharedCancel?: boolean } = {}): Promise<TestClient> {
  const schemaErrors: string[] = [];
  const crashes: ExitInfo[] = [];
  const unsolicited: EngineMessage[] = [];
  const skip = { on: false };
  const client = new EngineClient({
    clientName: "contract-tests",
    createTransport: () => checkingTransport(transportFor(kind, opts), schemaErrors, skip),
    onAnyMessage: (m) => {
      if (!validateEngineMessage(m)) schemaErrors.push(`${m.type}: ${JSON.stringify(validateEngineMessage.errors)}`);
    },
    onCrash: (i) => crashes.push(i),
    onUnsolicited: (m) => unsolicited.push(m),
  });
  await client.start();
  const unchecked = <T>(fn: () => T): T => {
    skip.on = true;
    try {
      return fn();
    } finally {
      skip.on = false;
    }
  };
  return { client, schemaErrors, crashes, unsolicited, unchecked };
}

// ---------------------------------------------------------------- mesh checks

export interface MeshCheck {
  triangles: number;
  vertices: number;
  indicesInRange: boolean;
  faceIdsMatchRanges: boolean;
  normalsUnit: boolean;
  /** Open edges after merging vertices that lie within 1e-4 mm; 0 means watertight. */
  openEdges: number;
  /** Volume enclosed by the triangles (divergence theorem). */
  meshVolume: number;
  edgeSegments: number;
}

export function checkMesh(payload: ArrayBuffer, body: BodyResult): MeshCheck {
  const v = meshViews(payload, body);
  const nV = v.positions.length / 3;
  const nT = v.indices.length / 3;
  let indicesInRange = true;
  for (const i of v.indices) if (i >= nV) indicesInRange = false;
  let faceIdsMatchRanges = v.faceIds.length === nT;
  for (const f of body.faces)
    for (let t = f.triangleStart; t < f.triangleStart + f.triangleCount; ++t) if (v.faceIds[t] !== f.faceId) faceIdsMatchRanges = false;
  let normalsUnit = true;
  for (let i = 0; i < nV; ++i) {
    const l = Math.hypot(v.normals[3 * i]!, v.normals[3 * i + 1]!, v.normals[3 * i + 2]!);
    if (Math.abs(l - 1) > 1e-4) normalsUnit = false;
  }
  // Merge coincident vertices (faces do not share vertices) and count directed edges without a partner.
  const key = (i: number) =>
    `${Math.round(v.positions[3 * i]! * 1e4)},${Math.round(v.positions[3 * i + 1]! * 1e4)},${Math.round(v.positions[3 * i + 2]! * 1e4)}`;
  const ids = new Map<string, number>();
  const merged = new Uint32Array(nV);
  for (let i = 0; i < nV; ++i) {
    const k = key(i);
    let id = ids.get(k);
    if (id === undefined) { id = ids.size; ids.set(k, id); }
    merged[i] = id;
  }
  const directed = new Map<string, number>();
  let vol = 0;
  for (let t = 0; t < nT; ++t) {
    const a = v.indices[3 * t]!, b = v.indices[3 * t + 1]!, c = v.indices[3 * t + 2]!;
    const tri = [merged[a]!, merged[b]!, merged[c]!];
    for (let e = 0; e < 3; ++e) {
      const k = `${tri[e]}>${tri[(e + 1) % 3]}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
    const p = (i: number) => [v.positions[3 * i]!, v.positions[3 * i + 1]!, v.positions[3 * i + 2]!] as const;
    const [ax, ay, az] = p(a), [bx, by, bz] = p(b), [cx, cy, cz] = p(c);
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  let open = 0;
  for (const [k, n] of directed) {
    const [x, y] = k.split(">");
    const back = directed.get(`${y}>${x}`) ?? 0;
    if (back !== n) open += Math.abs(n - back);
  }
  return {
    triangles: nT,
    vertices: nV,
    indicesInRange,
    faceIdsMatchRanges,
    normalsUnit,
    openEdges: open,
    meshVolume: vol,
    edgeSegments: v.edgeIds.length,
  };
}

/** Volume of P1a computed by hand: box - cylinder - fillet ring (Pappus over the corner spandrel). */
export function p1aVolume(length: number, width: number, height: number, holeD: number, r: number): number {
  const box = length * width * height;
  const cyl = Math.PI * (holeD / 2) ** 2 * height;
  const area = (1 - Math.PI / 4) * r * r;
  const centroid = (r * (10 - 3 * Math.PI)) / (3 * (4 - Math.PI)); // from the corner, along each axis
  return box - cyl - 2 * Math.PI * (holeD / 2 + centroid) * area;
}

export function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
