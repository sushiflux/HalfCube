#!/usr/bin/env node
// Track "salusoft-wasm" of the solver test: runs the solver-neutral case catalogue against the prebuilt
// @salusoft89/planegcs package (WebAssembly + wrapper) under Node.js and writes the result file.
//
//   node run.mjs [--only id,id] [--runs N] [--out file] [--no-iterations]
//
// What it does for every case entry (one per case, or one per algorithm for cases with run_algorithms):
//   1. translates the neutral elements/constraints into the package's JSON primitives (translate()),
//   2. pass 1: builds the system from the (deliberately off) start geometry, solves, applies the
//      solution, reads back geometry and the values of non-driving dimensions (timed),
//   3. pass 2: rebuilds the system from the solved geometry and solves once more to get the diagnosis
//      (dof, conflicting, redundant, partially redundant) - protocol of CASES.md section 1,
//   4. step sequences: step k starts from the geometry of step k-1 (drag = temporary constraints).
// The runner never looks at `expect`; every number in the result comes from the package.
//
// Timing: 1 warm-up run (also produces the diagnosis), then N (default 5) timed runs, each building the
// system from scratch. time_ms_median = median of the wall-clock time of the solve call alone
// (GcsWrapper.solve -> GcsSystem.solve_system, includes the solver's own initSolution + diagnosis at the
// start state); the time to push the primitives into the wasm system and to read the solution back is
// reported separately. For step sequences the time is the sum over all steps of one run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { init_planegcs_module, GcsWrapper, Algorithm, SolveStatus, DebugMode } from '@salusoft89/planegcs';
import { loadCases } from '../check/check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const require = createRequire(import.meta.url);

import { Unsupported, effectiveState, initialGeometry, makePlan } from './translate.mjs';

// ------------------------------------------------------------------------------------------------
// command line
// ------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = { runs: 5, iterations: true };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--only') opt.only = argv[++i].split(',');
  else if (a === '--runs') opt.runs = Number(argv[++i]);
  else if (a === '--out') opt.out = path.resolve(argv[++i]);
  else if (a === '--no-iterations') opt.iterations = false;
  else { console.error(`unknown argument ${a}`); process.exit(2); }
}
const OUT = opt.out || (opt.only
  ? path.join(HERE, '..', '_build', 'salusoft-wasm.partial.json')
  : path.join(HERE, '..', '_results', 'salusoft-wasm.json'));

// ------------------------------------------------------------------------------------------------
// small helpers
// ------------------------------------------------------------------------------------------------

const now = () => performance.now();
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const STATUS_NAME = Object.fromEntries(Object.entries(SolveStatus).map(([k, v]) => [v, k]));
const ALGO = { DogLeg: Algorithm.DogLeg, LevenbergMarquardt: Algorithm.LevenbergMarquardt, BFGS: Algorithm.BFGS };


// Memory limits of the shipped wasm binary, read from its memory section (no growth possible when min = max).
function wasmMemory() {
  const pkgDir = path.dirname(require.resolve('@salusoft89/planegcs'));
  const b = fs.readFileSync(path.join(pkgDir, 'planegcs_dist', 'planegcs.wasm'));
  let p = 8;
  const leb = () => { let r = 0, s = 0, x; do { x = b[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return r >>> 0; };
  while (p < b.length) {
    const id = b[p++]; const len = leb(); const end = p + len;
    if (id === 5) { leb(); const fl = b[p++]; const min = leb(); const max = (fl & 1) ? leb() : null; return { min, max, bytes_min: min * 65536 }; }
    p = end;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// session = one wasm module instance + wrapper
// ------------------------------------------------------------------------------------------------

// The module binds console.log / console.error as its stdout/stderr when it is created (the 'print' option
// is not honoured by the closure-compiled build), so the wrappers must be installed before the first module.
const CAPTURE = { on: false, lines: [], dropped: 0 };
const realLog = console.log.bind(console), realErr = console.error.bind(console);
// Output of the module (also the unconditional 'Sketcher Redundant solving' lines of its diagnosis) is dropped unless counting iterations.
console.log = (...a) => { if (CAPTURE.on) CAPTURE.lines.push(a.join(' ')); else CAPTURE.dropped++; };
console.error = (...a) => { if (CAPTURE.on) CAPTURE.lines.push(a.join(' ')); else CAPTURE.dropped++; };

async function newSession() {
  const mod = await init_planegcs_module();
  const gcs = new mod.GcsSystem();
  const w = new GcsWrapper(gcs, mod);
  return { mod, gcs, w, log: CAPTURE };
}
function closeSession(s) { try { s.w.destroy_gcs_module(); } catch { /* module may be aborted */ } }

function loadPlan(w, plan) {
  for (const op of plan.ops) {
    if (op.kind === 'param') w.push_sketch_param(op.name, op.value, false);
    else w.push_primitive(op.def);
  }
}

function readGeometry(w, caseDef) {
  const g = {};
  for (const e of caseDef.elements) {
    if (e.type === 'point') { const p = w.sketch_index.get_primitive(e.id); g[e.id] = { x: p.x, y: p.y }; }
    else if (e.type === 'circle' || e.type === 'arc') g[e.id] = { radius: w.sketch_index.get_primitive(e.id).radius };
  }
  return g;
}

function readDriven(w, plan, state) {
  const out = {};
  for (const [id, st] of state) {
    if (!st.enabled || st.driving) continue;
    const ref = plan.valueRef.get(id);
    if (!ref) continue;
    out[id] = w.sketch_index.get_primitive(ref.prim)[ref.prop];
  }
  return out;
}

// map package primitive ids (diagnosis lists) back to case constraint ids
function mapDiagnosis(w, plan) {
  const conflicting = new Set(), redundantPrims = new Set(), partialPrims = new Set(), internal = [];
  const owned = new Map(); // case constraint -> primitive ids
  for (const [pid, cid] of plan.owner) if (cid !== null) { if (!owned.has(cid)) owned.set(cid, []); owned.get(cid).push(pid); }
  const note = (pid, kind) => { if (plan.owner.get(pid) === null || !plan.owner.has(pid)) internal.push(`${kind}: ${plan.internalLabel.get(pid) || pid}`); };
  for (const pid of w.get_gcs_conflicting_constraints()) { const o = plan.owner.get(pid); if (o) conflicting.add(o); else note(pid, 'conflicting'); }
  for (const pid of w.get_gcs_redundant_constraints()) { redundantPrims.add(pid); if (!plan.owner.get(pid)) note(pid, 'redundant'); }
  for (const pid of w.get_gcs_partially_redundant_constraints()) { partialPrims.add(pid); if (!plan.owner.get(pid)) note(pid, 'partially redundant'); }
  const redundant = new Set(), partial = new Set();
  for (const [cid, prims] of owned) {
    const nr = prims.filter((p) => redundantPrims.has(p)).length;
    const np = prims.filter((p) => partialPrims.has(p)).length;
    if (nr === prims.length) redundant.add(cid);
    else if (nr > 0 || np > 0) partial.add(cid);
  }
  return { conflicting: [...conflicting], redundant: [...redundant], partially_redundant: [...partial], internal };
}

function diagnosisNow(s, plan) {
  return { dof: s.gcs.dof(), ...mapDiagnosis(s.w, plan) };
}

// ------------------------------------------------------------------------------------------------
// one step: pass 1 (solve) [+ pass 2 (diagnosis)]
// ------------------------------------------------------------------------------------------------

function runStep(s, caseDef, k, state, geom, alg, { diagnose, countIterations }) {
  const stepDef = k > 0 ? caseDef.steps[k - 1] : null;
  const drag = stepDef && stepDef.drag ? stepDef.drag : null;
  s.w.clear_data();
  const plan = makePlan(caseDef, state, geom, drag);
  const t0 = now();
  loadPlan(s.w, plan);
  const t1 = now();
  if (countIterations) { s.log.lines.length = 0; s.log.on = true; s.w.debug_mode = DebugMode.IterationLevel; }
  const statusCode = s.w.solve(alg);
  const t2 = now();
  if (countIterations) { s.w.debug_mode = DebugMode.NoDebug; s.log.on = false; }
  const res = { plan, status: STATUS_NAME[statusCode] ?? `code ${statusCode}`, statusCode, t_build: t1 - t0, t_solve: t2 - t1 };
  if (diagnose) res.diagnosis_at_start = diagnosisNow(s, plan);
  if (countIterations) {
    const n = s.log.lines.filter((l) => /Iteration:\s*\d+/.test(l)).length;
    // the SQP solver (drag, non-driving constraints) prints no iteration lines: not countable, so null
    res.iterations = n > 0 ? n : (plan.hasAux ? null : 0);
  }
  s.w.apply_solution();
  const t3 = now();
  res.geometry = readGeometry(s.w, caseDef);
  res.driven_values = readDriven(s.w, plan, state);
  res.t_total = (t3 - t0);
  return res;
}

function diagnosePass(s, caseDef, state, geom, alg) {
  s.w.clear_data();
  const plan = makePlan(caseDef, state, geom, null);
  loadPlan(s.w, plan);
  const code = s.w.solve(alg); // runs initSolution -> diagnose at the given (solved) geometry
  return { ...diagnosisNow(s, plan), pass2_status: STATUS_NAME[code] ?? `code ${code}`, kinks: plan.kinks };
}

// whole sequence (step 0 plus all steps) once
function runSequence(s, caseDef, alg, flags) {
  const nSteps = (caseDef.steps || []).length;
  let geom = initialGeometry(caseDef);
  const steps = [];
  for (let k = 0; k <= nSteps; k++) {
    const state = effectiveState(caseDef, k);
    const r = runStep(s, caseDef, k, state, geom, alg, flags);
    const step = { step: k, status: r.status, geometry: r.geometry, driven_values: r.driven_values, t_build: r.t_build, t_solve: r.t_solve, t_total: r.t_total };
    if (r.iterations !== undefined) step.iterations = r.iterations;
    if (r.diagnosis_at_start) step.diagnosis_at_start = r.diagnosis_at_start;
    if (flags.diagnose) {
      const stepDef = k > 0 ? caseDef.steps[k - 1] : null;
      const d = diagnosePass(s, caseDef, state, r.geometry, alg);
      Object.assign(step, { dof: d.dof, conflicting: d.conflicting, redundant: d.redundant, partially_redundant: d.partially_redundant, pass2_status: d.pass2_status });
      if (d.internal.length) step.internal_ids = d.internal;
      if (stepDef) step.label = stepDef.label;
    }
    step.plan = { mapText: r.plan.mapText, classOf: r.plan.classOf, kinks: r.plan.kinks };
    steps.push(step);
    geom = r.geometry;
  }
  return steps;
}

// ------------------------------------------------------------------------------------------------
// one result entry
// ------------------------------------------------------------------------------------------------

const CLASS_RANK = { direct: 0, composed: 1, missing: 2 };

function emptyEntry(caseDef, algorithm) {
  return {
    id: caseDef.id, mapping: '', supported: 'no', status: 'not supported', algorithm, iterations: null, time_ms_median: null, dof: null,
    conflicting: [], redundant: [], partially_redundant: [], geometry: {}, driven_values: {}, steps: [], notes: '',
  };
}

function maxClass(classOf) {
  let r = 'direct';
  for (const c of classOf.values()) if (CLASS_RANK[c] > CLASS_RANK[r]) r = c;
  return r;
}

async function runEntry(caseDef, algorithm, runs) {
  const entry = emptyEntry(caseDef, algorithm);
  const alg = ALGO[algorithm];
  const hasSteps = (caseDef.steps || []).length > 0;
  let s = null;
  try {
    // translation check first (cheap, no wasm): fails with Unsupported for things the package cannot express
    makePlan(caseDef, effectiveState(caseDef, 0), initialGeometry(caseDef), null);
    s = await newSession();
    // warm-up run = first full run, also produces the diagnosis
    // (the iteration count comes from this run too, so it belongs to the reported geometry)
    const first = runSequence(s, caseDef, alg, { diagnose: true, countIterations: opt.iterations });
    // timed runs
    const timedSolve = [], timedBuild = [], timedTotal = [];
    const perStep = first.map(() => []);
    let spread = 0;
    let nRuns = runs;
    for (let r = 0; r < nRuns; r++) {
      const seq = runSequence(s, caseDef, alg, { diagnose: false, countIterations: false });
      timedSolve.push(seq.reduce((a, x) => a + x.t_solve, 0));
      timedBuild.push(seq.reduce((a, x) => a + x.t_build, 0));
      timedTotal.push(seq.reduce((a, x) => a + x.t_total, 0));
      seq.forEach((x, i) => perStep[i].push(x.t_solve));
      // same input, same code: the geometry must not change between runs
      const last = seq[seq.length - 1].geometry, ref = first[first.length - 1].geometry;
      for (const [id, g] of Object.entries(ref)) for (const [k2, v] of Object.entries(g)) spread = Math.max(spread, Math.abs(last[id][k2] - v));
      if (r === 0 && timedSolve[0] > 3000) nRuns = 1; // very slow case: a single timed run
    }
    const iter = opt.iterations ? first : null;

    const last = first[first.length - 1];
    const classOf = last.plan.classOf;
    const cls = maxClass(classOf);
    entry.mapping = [`elements: point, line, circle, arc(+arc_rules), bspline`, last.plan.mapText].filter(Boolean).join(' | ');
    entry.mapping_class = cls;
    entry.supported = cls === 'direct' ? 'yes' : cls === 'composed' ? 'partial' : 'no';
    entry.status = last.status;
    entry.iterations = iter ? iter[iter.length - 1].iterations ?? null : null;
    entry.time_ms_median = median(timedSolve);
    entry.time_build_ms_median = median(timedBuild);
    entry.time_total_ms_median = median(timedTotal);
    entry.timing_runs = timedSolve.length;
    entry.timing_note = timedSolve.length < runs ? `warm-up run took more than 3 s: only ${timedSolve.length} timed run(s)` : `1 warm-up + ${timedSolve.length} timed runs, each from a freshly built system`;
    entry.geometry_spread_between_runs = spread; // max |difference| of the final geometry between the warm-up run and the timed runs
    entry.dof = last.dof;
    entry.conflicting = last.conflicting;
    entry.redundant = last.redundant;
    entry.partially_redundant = last.partially_redundant;
    entry.pass2_status = last.pass2_status;
    entry.diagnosis_at_start = last.diagnosis_at_start;
    entry.geometry = last.geometry;
    entry.driven_values = last.driven_values;
    const notes = [];
    if (last.internal_ids) notes.push(`internal helper constraints named by the diagnosis: ${last.internal_ids.join('; ')}`);
    if (iter) notes.push(`iterations = number of "Iteration:" lines of the package's IterationLevel debug output (all subsystems summed${hasSteps ? ', last step' : ''})`);
    if (hasSteps) {
      entry.steps = first.map((st, i) => {
        const o = { step: st.step, status: st.status, geometry: st.geometry, dof: st.dof, conflicting: st.conflicting, redundant: st.redundant, partially_redundant: st.partially_redundant, driven_values: st.driven_values, time_ms: median(perStep[i]), pass2_status: st.pass2_status };
        if (iter) o.iterations = iter[i].iterations;
        if (st.internal_ids) o.internal_ids = st.internal_ids;
        return o;
      });
      entry.time_ms_per_step_median = median(entry.steps.map((x) => x.time_ms));
      entry.time_ms_per_step_max = Math.max(...entry.steps.map((x) => x.time_ms));
      notes.push('time_ms_median = median over the timed runs of the sum of the solve times of all steps; steps[].time_ms = median over the runs for that step');
    }
    // a kink (knot multiplicity >= degree): the constraint is undefined, record what the package does anyway
    const kinks = last.plan.kinks;
    if (kinks && kinks.length) {
      entry.supported = 'no';
      entry.mapping_class = 'missing';
      notes.unshift(`NOT SUPPORTED (${kinks.join('; ')}): the slope of a spline is undefined at a kink. FreeCAD's Sketcher refuses this constraint (Sketch.cpp:3081-3103); the package has no such guard and passes it to ConstraintSlopeAtBSplineKnot (numpoles = degree - mult + 1 = 1 and assert(numpoles >= 2): Constraints.cpp:268-270 in FreeCAD 1.1.4, :288-290 in the package snapshot). Observed with the package: status ${last.status}, dof ${last.dof}, redundant [${last.redundant}], conflicting [${last.conflicting}]; the geometry below is what it returned.`);
    }
    entry.notes = notes.join(' || ');
  } catch (err) {
    const msg = String(err && err.message ? err.message : err).split('\n')[0];
    if (err instanceof Unsupported) {
      entry.supported = 'no'; entry.mapping = 'not supported'; entry.mapping_class = 'missing'; entry.status = 'not supported';
      entry.notes = msg;
    } else {
      entry.supported = 'yes'; // expressible, but the run failed
      entry.status = /abort/i.test(msg) ? msg.slice(0, 80) : `error: ${msg.slice(0, 200)}`;
      entry.notes = `run failed with: ${msg}${err && err.stack && !/abort/i.test(msg) ? ` (${String(err.stack).split('\n')[1]?.trim() ?? ''})` : ''}`;
      try { entry.mapping = makePlan(caseDef, effectiveState(caseDef, 0), initialGeometry(caseDef), null).mapText; } catch { /* ignore */ }
    }
  } finally {
    if (s) closeSession(s);
  }
  return entry;
}

// ------------------------------------------------------------------------------------------------
// main
// ------------------------------------------------------------------------------------------------

async function main() {
  const casesFile = path.join(HERE, '..', 'cases', 'cases.json');
  const doc = loadCases(casesFile);
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve('@salusoft89/planegcs')), '..', 'package.json'), 'utf8'));
  let commit = 'unknown';
  try { commit = fs.readFileSync(path.join(HERE, '..', '_deps', 'Salusoft-planegcs', 'planegcs', 'commit.txt'), 'utf8').trim(); } catch { /* optional */ }
  const mem = wasmMemory();
  // defaults of the solver as shipped
  const probe = await newSession();
  const defaults = { maxIter: probe.w.get_max_iterations(), convergence: probe.w.get_convergence_threshold() };
  closeSession(probe);

  const result = {
    track: 'salusoft-wasm',
    solver: `${pkg.name} ${pkg.version} (prebuilt WebAssembly + TypeScript wrapper; planegcs snapshot FreeCAD commit ${commit.slice(0, 8)} per the package repository's planegcs/commit.txt)`,
    build: {
      compiler: 'Emscripten, version of the shipped binary not recorded in the package (repository Dockerfile at tag 1.3.0: emscripten/emsdk:6.0.10, not verified for the npm binary); no C++ exceptions in the Release build (planegcs/CMakeLists.txt)',
      flags: 'Release: -O3 -sASSERTIONS=0 -sERROR_ON_UNDEFINED_SYMBOLS=0 -sELIMINATE_DUPLICATE_FUNCTIONS=1 --closure=1 -sMALLOC=emmalloc -sSTACK_SIZE=5MB -sEMBIND_AOT=1 (planegcs/CMakeLists.txt of the package repository)',
      eigen: 'system package libeigen3-dev of the emscripten/emsdk image, exact version not recorded (not verified)',
      boost: 'system packages (headers) of the image, exact version not recorded (not verified)',
      other: `wasm memory section of the shipped binary: min ${mem?.min} pages = max ${mem?.max} pages (${mem ? (mem.bytes_min / 1048576).toFixed(2) : '?'} MiB), i.e. no memory growth; solver defaults maxIter ${defaults.maxIter}, convergence ${defaults.convergence}; diagnosis QR = EigenSparseQR (debug output); package license field ${pkg.license}`,
    },
    runtime: `${os.type()} ${os.release()} ${os.arch()}, Node ${process.version}, ${os.cpus()[0]?.model ?? 'cpu unknown'}`,
    run_date: '2026-11-24',
    timing_method: `1 warm-up run (also used for the diagnosis), then median of ${opt.runs} timed runs of the wrapper's solve() call alone (GcsSystem.solve_system incl. the solver's own initSolution/diagnosis), each run on a freshly built system; build (push primitives) and total times are extra fields; step sequences: sum over all steps per run; a case whose first timed run exceeds 3 s gets a single timed run; one fresh wasm module per result entry`,
    cases: [],
  };

  const todo = [];
  for (const c of doc.cases) {
    if (opt.only && !opt.only.includes(c.id)) continue;
    for (const a of (c.run_algorithms && c.run_algorithms.length ? c.run_algorithms : ['DogLeg'])) todo.push([c, a]);
  }
  let i = 0;
  for (const [c, a] of todo) {
    i++;
    const t0 = now();
    const e = await runEntry(c, a, opt.runs);
    result.cases.push(e);
    realLog(`${String(i).padStart(3)}/${todo.length} ${c.id.padEnd(46)} ${a.padEnd(19)} ${e.supported.padEnd(7)} ${String(e.status).padEnd(12)} dof=${e.dof} t=${e.time_ms_median === null ? '-' : e.time_ms_median.toFixed(3)}ms (${(now() - t0).toFixed(0)} ms wall)`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  realLog(`wrote ${path.relative(ROOT, OUT)}`);
}

main().catch((err) => { realErr(err); process.exit(1); });
