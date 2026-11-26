#!/usr/bin/env node
// Drives a built engine through its message interface and checks every answer against the generated JSON Schema
// (protocol/engine-protocol.schema.json). No dependencies besides Node.
//
//   node engine/tests/drive-engine.mjs --native <halfcube-engine.exe> [--out result.json]
//   node engine/tests/drive-engine.mjs --wasm <folder with halfcube-engine.mjs> [--out result.json]
//   node engine/tests/drive-engine.mjs --compare <a.json> <b.json>
//
// Runs hello, ping, error cases, both self-tests, cancel and shutdown. Engines built with test commands also get
// diagnostics.hang (busy, cancelled while running, frozen) and diagnostics.crash (abort, nullcall, intdiv), each
// crash and the freeze in a fresh engine. Exit code 0 when every check passed.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const schema = JSON.parse(readFileSync(join(repo, "protocol", "engine-protocol.schema.json"), "utf8"));
const PROTOCOL_VERSION = Number(schema.$id.split(":").pop());
const PROTOCOL_ID = JSON.parse(readFileSync(join(repo, "protocol", "engine-protocol.json"), "utf8")).constants.find((c) => c.name === "protocolId").value;
const FRAME_MAGIC = 0x31454348;

// ------------------------------------------------------------------------------------ minimal JSON Schema check

function validate(value, s, path = "$") {
  if (s.$ref) return validate(value, schema.$defs[s.$ref.replace("#/$defs/", "")], path);
  if (s.oneOf) {
    const ok = s.oneOf.filter((alt) => validate(value, alt, path).length === 0);
    return ok.length === 1 ? [] : [`${path}: matches ${ok.length} of ${s.oneOf.length} alternatives`];
  }
  const errors = [];
  if (s.const !== undefined && value !== s.const) errors.push(`${path}: expected ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(s.enum)}`);
  if (s.type) {
    const t = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const okType = s.type === t || (s.type === "integer" && Number.isInteger(value)) || (s.type === "number" && t === "number");
    if (!okType) return [`${path}: expected ${s.type}, got ${t}`];
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) errors.push(`${path}: ${value} < ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) errors.push(`${path}: ${value} > ${s.maximum}`);
  }
  if (Array.isArray(value) && s.items) value.forEach((v, i) => errors.push(...validate(v, s.items, `${path}[${i}]`)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const r of s.required ?? []) if (!(r in value)) errors.push(`${path}: missing ${r}`);
    for (const [k, v] of Object.entries(value)) {
      if (s.properties && k in s.properties) errors.push(...validate(v, s.properties[k], `${path}.${k}`));
      else if (s.additionalProperties === false) errors.push(`${path}: unexpected field ${k}`);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") errors.push(...validate(v, s.additionalProperties, `${path}.${k}`));
    }
  }
  return errors;
}

// ------------------------------------------------------------------------------------ transports

class NativeEngine {
  constructor(exe) {
    this.exe = exe;
    this.proc = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.buffer = Buffer.alloc(0);
    this.listeners = [];
    this.stderr = "";
    this.exit = new Promise((res) => this.proc.on("exit", (code, signal) => res({ code, signal })));
    this.proc.stderr.on("data", (d) => (this.stderr += d.toString()));
    // A crashed or missing engine closes its pipes; the checks report that instead of Node aborting on EPIPE.
    this.proc.stdin.on("error", () => {});
    this.proc.on("error", (e) => (this.stderr += `could not start ${exe}: ${e.message}
`));
    this.proc.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 16) {
        const magic = this.buffer.readUInt32LE(0);
        if (magic !== FRAME_MAGIC) throw new Error(`broken frame stream: magic 0x${magic.toString(16)}`);
        const h = this.buffer.readUInt32LE(4), p = this.buffer.readUInt32LE(8);
        if (this.buffer.length < 16 + h + p) break;
        const header = this.buffer.subarray(16, 16 + h).toString("utf8");
        this.buffer = this.buffer.subarray(16 + h + p);
        this.deliver(JSON.parse(header));
      }
    });
  }
  deliver(m) {
    for (const l of this.listeners.splice(0)) l(m);
    this.onMessage?.(m);
  }
  send(obj) {
    const h = Buffer.from(JSON.stringify(obj), "utf8");
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(FRAME_MAGIC, 0);
    prefix.writeUInt32LE(h.length, 4);
    this.proc.stdin.write(Buffer.concat([prefix, h]));
  }
  async close() {
    this.proc.stdin.end();
    return this.exit;
  }
  kill() {
    this.proc.kill();
    return this.exit;
  }
}

class WasmEngine {
  constructor(dir, withCancelFlags = true) {
    this.moduleUrl = pathToFileURL(join(dir, "halfcube-engine.mjs")).href;
    this.cancelFlags = withCancelFlags ? new Int32Array(new SharedArrayBuffer(4)) : null;
    this.worker = new Worker(join(here, "wasm-worker.mjs"));
    this.stderr = "";
    this.fatal = null;
    this.ready = new Promise((res, rej) => {
      this.worker.on("message", (m) => {
        if (m.kind === "ready") res(m.instantiateMs);
        else if (m.kind === "msg") this.onMessage?.(JSON.parse(m.header));
        else if (m.kind === "log") this.stderr += m.text + "\n";
        else if (m.kind === "fatal") {
          this.fatal = m.message;
          this.onFatal?.(m.message);
          rej(new Error(m.message));
        }
      });
      this.worker.on("error", (e) => rej(e));
    });
    this.ready.catch(() => {});
    this.worker.postMessage({ kind: "init", moduleUrl: this.moduleUrl, cancelFlags: this.cancelFlags });
  }
  send(obj) {
    this.worker.postMessage({ kind: "msg", header: JSON.stringify(obj) });
  }
  async close() {
    await this.worker.terminate();
    return { code: 0, signal: null };
  }
  kill() {
    return this.close();
  }
}

// ------------------------------------------------------------------------------------ test session

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

class Session {
  constructor(engine) {
    this.engine = engine;
    this.nextId = 1;
    this.waiting = new Map();
    this.all = [];
    engine.onMessage = (m) => {
      this.all.push(m);
      const errs = validate(m, { $ref: "#/$defs/engineMessage" });
      if (errs.length) check(`schema of ${m.type} (replyTo ${m.replyTo})`, false, errs.join("; "));
      const w = this.waiting.get(m.replyTo);
      if (w) {
        this.waiting.delete(m.replyTo);
        w(m);
      }
    };
  }
  // Sends a command and waits for the first answer with its id (timeout in ms, null = no answer).
  request(type, fields = {}, timeoutMs = 60000) {
    const id = this.nextId++;
    const cmd = { type, id, ...fields };
    const cmdErrors = type.startsWith("bad.") ? [] : validate(cmd, { $ref: "#/$defs/command" });
    if (cmdErrors.length && !fields.__invalid) check(`schema of command ${type}`, false, cmdErrors.join("; "));
    delete cmd.__invalid;
    return { id, reply: this.sendRaw(cmd, timeoutMs) };
  }
  sendRaw(cmd, timeoutMs = 60000) {
    return new Promise((res) => {
      const timer = setTimeout(() => {
        this.waiting.delete(cmd.id);
        res(null);
      }, timeoutMs);
      this.waiting.set(cmd.id, (m) => {
        clearTimeout(timer);
        res(m);
      });
      this.engine.send(cmd);
    });
  }
  async call(type, fields, timeoutMs) {
    return this.request(type, fields, timeoutMs).reply;
  }
}

const stripTimes = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === "timeMs" || k === "replyTo" ? undefined : v)));

async function startEngine(kind, target) {
  const engine = kind === "native" ? new NativeEngine(target) : new WasmEngine(target);
  const t0 = performance.now();
  if (kind === "wasm") await engine.ready;
  const s = new Session(engine);
  const hello = await s.call("hello", { protocol: PROTOCOL_VERSION, protocolId: PROTOCOL_ID, client: "drive-engine.mjs" }, 20000);
  return { engine, s, hello, startMs: performance.now() - t0 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(kind, target) {
  const result = { kind, target, checks };
  const { engine, s, hello, startMs } = await startEngine(kind, target);
  result.startAndHelloMs = startMs;
  check("hello answers helloResult", hello?.type === "helloResult", hello?.type === "error" ? hello.message : hello ? "" : `no answer; engine stderr: ${engine.stderr.trim() || "(empty)"}`);
  if (hello?.type !== "helloResult") return finish(result, engine);
  result.hello = stripTimes(hello);
  const expectPlatform = kind === "native" ? "native" : "wasm";
  check("hello names the protocol version and id", hello.protocol === PROTOCOL_VERSION && hello.protocolId === PROTOCOL_ID, `${hello.protocol} / ${hello.protocolId}`);
  check("hello names the platform", hello.engine.platform === expectPlatform, hello.engine.platform);
  check("hello names OCCT 8.0.2", hello.components.occt === "8.0.2", hello.components.occt);
  check("hello names planegcs FreeCAD 1.1.4 4fd3bf32", hello.components.planegcs.source === "FreeCAD 1.1.4" && hello.components.planegcs.commit.startsWith("4fd3bf32"));
  check("hello names Eigen 3.4.0", hello.components.eigen === "3.4.0", hello.components.eigen);
  const testCommands = hello.engine.testCommands;

  const pong = await s.call("ping");
  check("ping answers pong", pong?.type === "pong" && pong.busyWith === null, JSON.stringify(pong));

  const unknown = await s.call("bad.command", { __invalid: true });
  check("unknown command is refused", unknown?.code === "unknown_command", unknown?.message);
  const badField = await s.call("cancel", { target: "x", __invalid: true });
  check("wrong field type is named", badField?.code === "bad_message" && /field "target"/.test(badField.message), badField?.message);
  const notFound = await s.call("cancel", { target: 999 });
  check("cancel of an unknown id answers notFound", notFound?.state === "notFound");

  const kernel = await s.call("diagnostics.kernelSelftest");
  check("kernel self-test passes", kernel?.passed === true, kernel?.problem ?? `volume ${kernel?.volume}, faces ${kernel?.faceCount}, ${kernel?.timeMs?.toFixed(2)} ms`);
  result.kernelSelftest = kernel;
  const solver = await s.call("diagnostics.solverSelftest");
  check("solver self-test passes", solver?.passed === true,
    solver?.problem ?? `dof ${solver?.dof}, residual ${solver?.maxResidual}, deviation ${solver?.maxDeviation}, ${solver?.timeMs?.toFixed(2)} ms`);
  result.solverSelftest = solver;

  // sketch.solve with regions and a drag step (B7): a 60 x 40 rectangle with a circle of diameter 10 in it.
  const pt = (id, x, y) => ({ id, x, y });
  const ln = (id, p1, p2) => ({ id, p1, p2, construction: false });
  const gc = (id, kind, refs) => ({ id, kind, refs });
  const dm = (id, kind, refs, value) => ({ id, kind, refs, value: { value, unit: "mm" }, driving: true, label: { x: 0, y: 0 } });
  const frame = {
    points: [pt("p1", 0.2, -0.1), pt("p2", 59.5, 0.3), pt("p3", 60.4, 40.2), pt("p4", -0.3, 39.6), pt("pc", 20, 20)],
    lines: [ln("l1", "p1", "p2"), ln("l2", "p2", "p3"), ln("l3", "p3", "p4"), ln("l4", "p4", "p1")],
    circles: [{ id: "c1", center: "pc", radius: 5, construction: false }],
    constraints: [
      gc("k1", "horizontal", ["l1"]), gc("k2", "horizontal", ["l3"]), gc("k3", "vertical", ["l2"]), gc("k4", "vertical", ["l4"]),
      dm("d1", "distance", ["l1"], 60), dm("d2", "distance", ["l2"], 40), gc("k5", "fix", ["pc"]), dm("d3", "diameter", ["c1"], 10),
    ],
  };
  const plane = { kind: "originPlane", plane: "xy" };
  const pinned = { ...frame, constraints: [...frame.constraints, gc("k6", "coincident", ["p1", "@origin"])] };
  const regions = await s.call("sketch.solve", { sketch: pinned, plane, profiles: true });
  check("sketch.solve with regions answers sketchSolveResult", regions?.type === "sketchSolveResult" && regions.status === "solved", regions?.message ?? regions?.status);
  check("a determined rectangle with a circle gives two determined regions with outlines",
    regions?.profiles?.length === 2 && regions.profiles.every((r) => r.determined) && regions.profiles.map((r) => r.loops.length).sort().join() === "1,2",
    JSON.stringify(regions?.profiles?.map((r) => [r.key, r.determined, r.loops?.length])));
  const free = await s.call("sketch.solve", { sketch: frame, plane, profiles: true });
  check("without the corner on the origin the frame region is not determined, the circle's is",
    free?.profiles?.find((r) => r.key === "c1")?.determined === true && free.profiles.find((r) => r.key !== "c1")?.determined === false,
    JSON.stringify(free?.profiles?.map((r) => [r.key, r.determined])));
  check("what is still free: the dimensioned rectangle off the origin can only be moved, one fact; pinned, nothing",
    regions?.freedom?.length === 0 && free?.freedom?.length === 1 && free.freedom[0].kind === "position" && free.freedom[0].shape === "rectangle" &&
      free.freedom[0].moves === 2 && free.freedom[0].elements.join() === "l1,l2,l3,l4",
    JSON.stringify([regions?.freedom, free?.freedom]));
  const dragged = await s.call("sketch.solve", { sketch: frame, plane, profiles: true, drag: { points: [{ id: "p3", x: 70, y: 52 }] } });
  const p3 = dragged?.points?.find((p) => p.id === "p3");
  check("a drag step moves a corner of the rectangle to the target and keeps its size",
    dragged?.status === "solved" && dragged.drag?.complete === true && dragged.drag.points[0].moved === true && dragged.drag.points[0].error < 1e-6 &&
      Math.abs(p3.x - 70) < 1e-6 && Math.abs(p3.y - 52) < 1e-6 && dragged.profiles?.length === 2,
    JSON.stringify(dragged?.drag));
  // The editor sends the sketch as the last solve left it; a point "moved" relative to that.
  const pinnedSolved = { ...pinned, points: pinned.points.map((p) => ({ ...p, ...regions.points.find((q) => q.id === p.id) })) };
  const stuck = await s.call("sketch.solve", { sketch: pinnedSolved, plane, profiles: true, drag: { points: [{ id: "p3", x: 90, y: 90 }] } });
  check("a drag of a fully determined corner does not move it and says so",
    stuck?.status === "solved" && stuck.drag?.points[0].moved === false && stuck.drag.points[0].error > 40 && stuck.dof === 0,
    JSON.stringify(stuck?.drag));
  // Distances to what was clicked (reference dimensions measure them) and the angle between two rays.
  const ref = (id, kind, refs, extra = {}) => ({ id, kind, refs, value: { value: 1, unit: kind === "angle" ? "deg" : "mm" }, driving: false, label: { x: 0, y: 0 }, ...extra });
  const clicked = await s.call("sketch.solve", {
    sketch: {
      ...pinned,
      constraints: [...pinned.constraints,
        ref("e1", "distance", ["pc", "l1"]), ref("e2", "distance", ["c1", "l1"]), ref("e3", "distance", ["p3", "c1"]),
        ref("e4", "distance", ["l1", "l3"]), ref("e5", "angle", ["l1", "l4"], { reverse: [false, true] }), ref("e6", "angle", ["l1", "l4"])],
    },
    plane,
  });
  const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-9;
  check("distances measure what was clicked: centre to line, rim to line, point to rim, parallel lines",
    clicked?.status === "solved" && near(clicked.reference?.e1, 20) && near(clicked.reference?.e2, 15) && near(clicked.reference?.e3, Math.hypot(40, 20) - 5) && near(clicked.reference?.e4, 40),
    JSON.stringify(clicked?.reference));
  check("the angle between two rays at a rectangle corner is 90, the one between the directions is -90",
    near(clicked?.reference?.e5, 90) && near(clicked?.reference?.e6, -90), JSON.stringify([clicked?.reference?.e5, clicked?.reference?.e6]));
  result.clickedDistances = clicked?.reference;
  const badReverse = await s.call("sketch.solve", { sketch: { ...pinned, constraints: [ref("e7", "angle", ["l1", "l4"], { reverse: [true] })] }, plane });
  check("reverse with one flag is refused with bad_document naming the field", badReverse?.code === "bad_document" && /reverse/.test(badReverse.message), badReverse?.message);
  const badDrag = await s.call("sketch.solve", { sketch: frame, plane, drag: { points: [{ id: "nope", x: 1, y: 1 }] } });
  check("a drag of an unknown point is refused with bad_message naming the field", badDrag?.code === "bad_message" && /drag\.points\[0\]\.id/.test(badDrag.message), badDrag?.message);

  if (!testCommands) {
    const crash = await s.call("diagnostics.crash", { mode: "abort" });
    check("test command is refused without test commands", crash?.code === "test_commands_disabled", crash?.message);
  } else {
    const busy = await s.call("diagnostics.hang", { mode: "busy", ms: 30 });
    check("hang busy 30 ms answers", busy?.type === "hangResult" && busy.ms >= 30, `${busy?.ms?.toFixed(1)} ms`);
    // Cancel a running command: native through a cancel command, WebAssembly through the shared cancel flag.
    const long = s.request("diagnostics.hang", { mode: "busy" });
    await sleep(150);
    if (kind === "native") {
      const ping = await s.call("ping", {}, 2000);
      check("native ping is answered while a command runs", ping?.busyWith === long.id, JSON.stringify(ping));
      const cancel = await s.call("cancel", { target: long.id }, 2000);
      check("cancel finds the running command", cancel?.state === "running", JSON.stringify(cancel));
    } else {
      Atomics.store(engine.cancelFlags, 0, long.id);
    }
    const cancelled = await long.reply;
    check("running command ends as cancelled", cancelled?.code === "cancelled", cancelled?.message);
    if (kind === "wasm") Atomics.store(engine.cancelFlags, 0, 0);
  }

  const bye = await s.call("shutdown");
  check("shutdown answers bye", bye?.type === "bye");
  const exit = await engine.close();
  if (kind === "native") check("native engine exits with 0 after shutdown", exit.code === 0, `exit ${exit.code}`);

  if (testCommands) {
    // Freeze: no answer at all, not even to ping, until the engine is ended from outside.
    const f = await startEngine(kind, target);
    f.s.request("diagnostics.hang", { mode: "frozen" });
    await sleep(200);
    const t0 = performance.now();
    const ping = await f.s.call("ping", {}, 2000);
    check("frozen engine answers no ping within 2 s", ping === null, ping ? JSON.stringify(ping) : `${(performance.now() - t0).toFixed(0)} ms without answer`);
    await f.engine.kill();
    for (const mode of ["abort", "nullcall", "intdiv"]) {
      const c = await startEngine(kind, target);
      let fatal = null;
      if (kind === "wasm") c.engine.onFatal = (m) => (fatal = m);
      c.s.request("diagnostics.crash", { mode }, 5000);
      if (kind === "native") {
        const ex = await Promise.race([c.engine.exit, sleep(5000).then(() => null)]);
        check(`crash ${mode} ends the native process`, ex && ex.code !== 0, ex ? `exit code ${ex.code} (0x${(ex.code >>> 0).toString(16)})` : "still running");
        if (!ex) await c.engine.kill();
      } else {
        await sleep(1000);
        check(`crash ${mode} traps the WebAssembly module`, fatal !== null, fatal ?? "no trap");
        await c.engine.close();
      }
    }
  }
  return finish(result);
}

function finish(result, engine) {
  if (engine) engine.kill();
  result.passed = checks.every((c) => c.ok);
  return result;
}

// ------------------------------------------------------------------------------------ compare

function compare(aPath, bPath) {
  const a = JSON.parse(readFileSync(aPath, "utf8"));
  const b = JSON.parse(readFileSync(bPath, "utf8"));
  let maxRel = 0;
  const diffs = [];
  const walk = (x, y, path) => {
    if (typeof x === "number" && typeof y === "number") {
      const rel = x === y ? 0 : Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y), 1e-300);
      if (rel > maxRel) maxRel = rel;
      if (rel > 1e-9) diffs.push(`${path}: ${x} vs ${y}`);
      return;
    }
    if (typeof x !== typeof y || Array.isArray(x) !== Array.isArray(y)) return diffs.push(`${path}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
    if (x && typeof x === "object") {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${path}.${k}`);
      return;
    }
    if (x !== y) diffs.push(`${path}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
  };
  for (const key of ["kernelSelftest", "solverSelftest"]) walk(stripTimes(a[key]), stripTimes(b[key]), key);
  console.log(`compared ${aPath} (${a.kind}) with ${bPath} (${b.kind}): ${diffs.length} differences above 1e-9 relative, largest relative difference ${maxRel}`);
  for (const d of diffs) console.log(`  ${d}`);
  process.exit(diffs.length ? 1 : 0);
}

// ------------------------------------------------------------------------------------ main

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args[0] === "--compare") compare(args[1], args[2]);
else {
  const kind = opt("--native") ? "native" : opt("--wasm") ? "wasm" : null;
  if (!kind) {
    console.error("usage: drive-engine.mjs --native <exe> | --wasm <folder> [--out result.json] | --compare <a.json> <b.json>");
    process.exit(64);
  }
  const target = resolve(opt(`--${kind}`));
  const result = await run(kind, target);
  const out = opt("--out");
  if (out) {
    // CI starts from a clean checkout, so the result folder may not exist yet.
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`${checks.length - failed} of ${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
