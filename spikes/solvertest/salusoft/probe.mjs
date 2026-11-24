#!/usr/bin/env node
// Extra experiments against the prebuilt @salusoft89/planegcs package. They are NOT part of the result file;
// they back statements about the package with numbers produced by running code.
//
//   node probe.mjs scaling           size at which the 21 MiB fixed wasm heap runs out (grid sketches of the P cases)
//   node probe.mjs bspline-helpers   does tying the spline's internal start/end helper points to the end poles fix the DOF?
//   node probe.mjs repeat            same input solved repeatedly in one module versus fresh modules
//
// Module output is swallowed, as in run.mjs.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init_planegcs_module, GcsWrapper, Algorithm } from '@salusoft89/planegcs';
import { loadCases } from '../check/check.mjs';
import { makePlan, effectiveState, initialGeometry } from './translate.mjs';

const CASES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases', 'cases.json');
const realLog = console.log.bind(console);
console.log = () => {};
console.error = () => {};
const out = (...a) => realLog(...a);

async function session() {
  const mod = await init_planegcs_module();
  const gcs = new mod.GcsSystem();
  return { mod, gcs, w: new GcsWrapper(gcs, mod) };
}
function load(w, plan) {
  for (const op of plan.ops) { if (op.kind === 'param') w.push_sketch_param(op.name, op.value, false); else w.push_primitive(op.def); }
}

// same recipe as gridCase() in cases/build-cases.mjs (rows x cols rectangles, 8 elements each)
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function grid(rows, cols, seed) {
  const rand = rng(seed); const off = (s) => (rand() - 0.5) * 2 * s;
  const W = (r, k) => 8 + ((r * 7 + k * 3) % 7), H = (r, k) => 6 + ((r * 5 + k * 2) % 5);
  const elements = [], constraints = []; let n = 0;
  const con = (type, refs, value) => { const c = { id: `c${++n}`, type, ...refs }; if (value !== undefined) c.value = value; constraints.push(c); };
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
    let x = 0, y = 0; for (let j = 0; j < k; j++) x += W(r, j); for (let j = 0; j < r; j++) y += H(j, 0);
    const w = W(r, k), h = H(r, k), id = (s) => `R${r}_${k}${s}`;
    elements.push({ id: id('BL'), type: 'point', x: x + off(1.5), y: y + off(1.5) }, { id: id('BR'), type: 'point', x: x + w + off(1.5), y: y + off(1.5) },
      { id: id('TR'), type: 'point', x: x + w + off(1.5), y: y + h + off(1.5) }, { id: id('TL'), type: 'point', x: x + off(1.5), y: y + h + off(1.5) },
      { id: id('b'), type: 'line', p1: id('BL'), p2: id('BR') }, { id: id('r'), type: 'line', p1: id('BR'), p2: id('TR') },
      { id: id('t'), type: 'line', p1: id('TR'), p2: id('TL') }, { id: id('l'), type: 'line', p1: id('TL'), p2: id('BL') });
  }
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
    const m = (s) => `R${r}_${k}${s}`;
    con('horizontal', { line: m('b') }); con('horizontal', { line: m('t') }); con('vertical', { line: m('r') }); con('vertical', { line: m('l') });
    con('length', { line: m('b') }, W(r, k)); con('length', { line: m('l') }, H(r, k));
    if (r === 0 && k === 0) con('fix', { point: m('BL'), x: 0, y: 0 });
    else if (k > 0) con('coincident', { p1: m('BL'), p2: `R${r}_${k - 1}BR` });
    else con('coincident', { p1: m('BL'), p2: `R${r - 1}_0TL` });
  }
  return { id: `grid-${rows}x${cols}`, elements, constraints };
}

async function scaling() {
  out('rows x cols  elements constraints  result');
  for (const [rows, cols] of [[5, 5], [5, 6], [5, 8], [5, 10], [5, 12], [5, 15], [5, 20], [5, 25], [1, 25], [1, 50]]) {
    const c = grid(rows, cols, 33);
    const s = await session();
    let res;
    let phase = 'build';
    try {
      const plan = makePlan(c, effectiveState(c, 0), initialGeometry(c), null);
      const t0 = performance.now();
      load(s.w, plan);
      const tLoad = performance.now() - t0;
      phase = 'solve';
      const t = performance.now();
      const st = s.w.solve(Algorithm.DogLeg);
      res = `status ${st}, build ${tLoad.toFixed(1)} ms, solve ${(performance.now() - t).toFixed(1)} ms, dof ${s.gcs.dof()}`;
    } catch (e) { res = `${String(e.message).split('\n')[0]} (during ${phase})`; }
    out(`${String(rows).padStart(4)} x ${String(cols).padEnd(4)} ${String(c.elements.length).padStart(8)} ${String(c.constraints.length).padStart(11)}  ${res}`);
  }
}

async function bsplineHelpers() {
  const doc = loadCases(CASES);
  for (const id of ['K02e-point-on-bspline', 'B03b-periodic-spline-point-on-curve', 'B07-rational-quarter-circle', 'B04-quadratic-spline-tangent-at-interior-knot', 'B05-cubic-spline-tangent-at-c1-knot']) {
    const c = doc.cases.find((x) => x.id === id);
    for (const tie of [false, true]) {
      const s = await session();
      const geom = initialGeometry(c);
      const plan = makePlan(c, effectiveState(c, 0), geom, null);
      const spl = c.elements.find((e) => e.type === 'bspline');
      let helper = null;
      // The spline's helper parameters (start x/y, end x/y, then weights and knots) are pushed by the first
      // constraint that names the spline; its first parameter push is the spline, so they start at params_size()
      // from before that constraint.
      for (const op of plan.ops) {
        const before = s.w.gcs.params_size();
        if (op.kind === 'param') s.w.push_sketch_param(op.name, op.value, false); else s.w.push_primitive(op.def);
        if (!helper && op.kind === 'prim' && op.def.id !== spl.id && Object.values(op.def).includes(spl.id)) helper = { start: before };
      }
      if (tie && helper) {
        const first = s.w.p_param_index.get(spl.poles[0]), last = s.w.p_param_index.get(spl.poles[spl.poles.length - 1]);
        const mk = (i) => s.gcs.make_point(i, i + 1);
        s.gcs.add_constraint_p2p_coincident(mk(helper.start), mk(first), 100000, true, 1);
        s.gcs.add_constraint_p2p_coincident(mk(helper.start + 2), mk(last), 100001, true, 1);
      }
      const st = s.w.solve(Algorithm.DogLeg);
      out(`${id.padEnd(46)} helpers tied to end poles: ${String(tie).padEnd(5)} status ${st} dof ${s.gcs.dof()}`);
    }
  }
}

async function repeat() {
  const doc = loadCases(CASES);
  for (const id of ['C04-redundant-parallel', 'K12a-curvature-arc-arc', 'K03a-tangent-line-circle']) {
    const c = doc.cases.find((x) => x.id === id);
    const runIn = async (s, n) => {
      const res = [];
      for (let i = 0; i < n; i++) {
        s.w.clear_data();
        load(s.w, makePlan(c, effectiveState(c, 0), initialGeometry(c), null));
        const st = s.w.solve(Algorithm.DogLeg); s.w.apply_solution();
        res.push({ st, p: s.w.get_gcs_params().slice() });
      }
      return res;
    };
    const d = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    const A = await runIn(await session(), 4), B = await runIn(await session(), 4);
    out(`${id}: one module, runs 1..4 vs run 1: ${[1, 2, 3].map((i) => d(A[0].p, A[i].p).toExponential(2))}; second fresh module: run 1 vs run 1 ${d(A[0].p, B[0].p).toExponential(2)}, run 4 vs run 4 ${d(A[3].p, B[3].p).toExponential(2)}; statuses ${A.map((x) => x.st)}`);
  }
}

const cmd = process.argv[2];
if (cmd === 'scaling') await scaling();
else if (cmd === 'bspline-helpers') await bsplineHelpers();
else if (cmd === 'repeat') await repeat();
else { out('usage: node probe.mjs scaling | bspline-helpers | repeat'); process.exit(2); }
