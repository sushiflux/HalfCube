#!/usr/bin/env node
// Independent checker of the solver test.
//
//   node check/check.mjs <cases.json> <result.json> [--only id1,id2] [--tol-length x] [--tol-angle x]
//                        [--tol-curvature x] [--json] [--quiet]
//
// Prints one line per case entry (PASS / FAIL with reasons / SKIP) and a summary. The exit code is 0
// only if no entry is FAIL and the result file has the right shape. The checker contains no solver
// code: every geometric condition is recomputed from the coordinates in "geometry" / "steps".
// Soft expectations (expect.soft) only produce a WARN note.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Ctx, residuals, measure, DIMENSION_TYPES, isAngular, wrapPi, signedArea2, V, onArcSpan,
  bsplineEval, bsplineDomain,
} from './lib.mjs';

const DEFAULT_TOL = { length: 1e-6, angle: 1e-6, curvature: 1e-5 };
const ALGORITHMS = ['DogLeg', 'LevenbergMarquardt', 'BFGS'];

// ------------------------------------------------------------------------------------------------
// loading
// ------------------------------------------------------------------------------------------------

export function loadCases(file) {
  const dir = path.dirname(file);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cases = doc.cases.map((c) => {
    if (c.file) {
      const full = JSON.parse(fs.readFileSync(path.join(dir, c.file), 'utf8'));
      return { ...full, id: c.id };
    }
    return c;
  });
  return { ...doc, cases };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ------------------------------------------------------------------------------------------------
// effective constraint set of a step
// ------------------------------------------------------------------------------------------------

function effectiveState(caseDef, stepIndex) {
  const state = new Map();
  for (const c of caseDef.constraints) {
    state.set(c.id, { c, enabled: c.enabled !== false, value: c.value, driving: c.driving !== false, x: c.x, y: c.y });
  }
  const steps = caseDef.steps || [];
  for (let k = 1; k <= stepIndex; k++) {
    const s = steps[k - 1];
    if (!s) continue;
    for (const id of s.disable || []) state.get(id).enabled = false;
    for (const id of s.enable || []) state.get(id).enabled = true;
    for (const [id, v] of Object.entries(s.set || {})) {
      const st = state.get(id);
      if (typeof v === 'number') st.value = v;
      else { if (v.value !== undefined) st.value = v.value; if (v.x !== undefined) st.x = v.x; if (v.y !== undefined) st.y = v.y; }
    }
  }
  return state;
}

// ------------------------------------------------------------------------------------------------
// expectation helpers for the id sets
// ------------------------------------------------------------------------------------------------

function normSetSpec(spec) {
  if (spec === undefined) return { mode: 'empty' };
  if (Array.isArray(spec)) return { mode: 'exact', ids: spec };
  return spec;
}

function checkSet(name, actual, spec) {
  const s = normSetSpec(spec);
  const act = [...new Set(actual)].sort();
  switch (s.mode) {
    case 'any': return null;
    case 'empty': return act.length === 0 ? null : `${name} should be empty but is [${act}]`;
    case 'exact': {
      const exp = [...s.ids].sort();
      return JSON.stringify(exp) === JSON.stringify(act) ? null : `${name} expected exactly [${exp}] but is [${act}]`;
    }
    case 'within': {
      const outside = act.filter((i) => !s.ids.includes(i));
      if (outside.length) return `${name} [${act}] contains ids outside [${s.ids}]`;
      if (act.length < (s.min ?? 1)) return `${name} expected at least ${s.min ?? 1} id(s) out of [${s.ids}] but is [${act}]`;
      if (s.count !== undefined && act.length !== s.count) return `${name} expected exactly ${s.count} id(s) out of [${s.ids}] but is [${act}]`;
      return null;
    }
    default: return `unknown set mode '${s.mode}' in the case file`;
  }
}

// ------------------------------------------------------------------------------------------------
// the geometric checks of one solved state
// ------------------------------------------------------------------------------------------------

function tolFor(unit, tol) { return unit === 'len' ? tol.length : unit === 'ang' ? tol.angle : tol.curvature; }

function checkGeometry({ caseDef, geometry, drivenValues, state, tol, label, problems, skipConstraints }) {
  const ctx = new Ctx(caseDef, geometry);

  // every element must have solved values
  for (const e of caseDef.elements) {
    const g = geometry[e.id];
    if (e.type === 'point') {
      if (!g || !isNum(g.x) || !isNum(g.y)) { problems.push(`${label}missing or non-numeric coordinates of point ${e.id}`); return null; }
    } else if (e.type === 'circle' || e.type === 'arc') {
      if (!g || !isNum(g.radius)) { problems.push(`${label}missing radius of ${e.type} ${e.id}`); return null; }
      if (g.radius <= 0) problems.push(`${label}${e.type} ${e.id} has non-positive radius ${g.radius}`);
    }
  }

  // fixed points must not move
  for (const e of caseDef.elements) {
    if (e.type === 'point' && e.fixed) {
      const g = geometry[e.id];
      if (Math.hypot(g.x - e.x, g.y - e.y) > 1e-9) problems.push(`${label}fixed point ${e.id} moved from (${e.x},${e.y}) to (${g.x},${g.y})`);
    }
  }

  // arc consistency: both end points on the circle
  for (const e of caseDef.elements) {
    if (e.type !== 'arc') continue;
    const a = ctx.arc(e.id);
    const ds = V.len(V.sub(a.s, a.c)) - a.r, de = V.len(V.sub(a.e, a.c)) - a.r;
    if (Math.abs(ds) > tol.length) problems.push(`${label}arc ${e.id}: start point is ${ds.toExponential(2)} off its circle`);
    if (Math.abs(de) > tol.length) problems.push(`${label}arc ${e.id}: end point is ${de.toExponential(2)} off its circle`);
  }

  // constraints
  for (const [id, st] of state) {
    if (!st.enabled || skipConstraints) continue;
    const c = { ...st.c, value: st.value, x: st.x, y: st.y };
    try {
      if (st.driving) {
        for (const r of residuals(ctx, c)) {
          const t = tolFor(r.unit, tol);
          if (!(Math.abs(r.value) <= t)) problems.push(`${label}constraint ${id} (${c.type}) violated: ${r.name} = ${r.value.toExponential(3)} (tolerance ${t})`);
        }
      } else if (DIMENSION_TYPES.has(c.type)) {
        const m = measure(ctx, c);
        const reported = drivenValues ? drivenValues[id] : undefined;
        if (!isNum(reported)) problems.push(`${label}non-driving ${id} (${c.type}): no value in driven_values`);
        else {
          const diff = isAngular(c.type) ? wrapPi(reported - m) : reported - m;
          const t = isAngular(c.type) ? tol.angle : tol.length;
          if (!(Math.abs(diff) <= t)) problems.push(`${label}non-driving ${id} (${c.type}): reported ${reported} but the geometry measures ${m} (diff ${diff.toExponential(2)})`);
        }
      }
    } catch (err) {
      problems.push(`${label}constraint ${id} (${c.type}) could not be evaluated: ${err.message}`);
    }
  }
  return ctx;
}

function runExtraChecks(list, { caseDef, ctx, initialCtx, tol, label, problems }) {
  for (const ch of list || []) {
    try {
      switch (ch.kind) {
        case 'unchanged': {
          for (const id of ch.ids) {
            const e = caseDef.elements.find((x) => x.id === id);
            const p = ctx.P(id);
            const d = Math.hypot(p[0] - e.x, p[1] - e.y);
            if (d > (ch.tol ?? tol.length)) problems.push(`${label}point ${id} should be unchanged but moved by ${d.toExponential(2)}`);
          }
          break;
        }
        case 'point_at': {
          const p = ctx.P(ch.point);
          const d = Math.hypot(p[0] - ch.x, p[1] - ch.y);
          if (d > (ch.tol ?? tol.length)) problems.push(`${label}point ${ch.point} is at (${p[0]},${p[1]}) but should be at (${ch.x},${ch.y}) (off by ${d.toExponential(2)})`);
          break;
        }
        case 'holds': {
          for (const r of residuals(ctx, ch.constraint)) {
            const t = ch.tol ?? tolFor(r.unit, tol);
            if (!(Math.abs(r.value) <= t)) problems.push(`${label}check ${JSON.stringify(ch.constraint)} fails: ${r.name} = ${r.value.toExponential(3)}`);
          }
          break;
        }
        case 'orientation': {
          const a = signedArea2(ctx, ch.points);
          if (Math.sign(a) !== ch.sign) problems.push(`${label}orientation of [${ch.points}] flipped: signed area*2 = ${a} (expected sign ${ch.sign})`);
          break;
        }
        case 'on_arc_span': {
          const a = ctx.arc(ch.arc);
          if (!onArcSpan(a.c, a.s, a.e, ctx.P(ch.point))) problems.push(`${label}point ${ch.point} is not on the angular span of arc ${ch.arc}`);
          break;
        }
        case 'closed_curve': {
          const { spec, poles } = ctx.bspline(ch.bspline);
          const [u0, u1] = bsplineDomain(spec);
          const A = bsplineEval(spec, poles, u0, 2), B = bsplineEval(spec, poles, u1, 2);
          for (let d = 0; d <= 2; d++) {
            const diff = V.len(V.sub(A[d], B[d]));
            if (diff > 1e-6 * Math.max(1, V.len(A[d]))) problems.push(`${label}periodic spline ${ch.bspline} is not closed at derivative ${d} (diff ${diff.toExponential(2)})`);
          }
          break;
        }
        case 'max_jump': break; // evaluated between steps
        default: problems.push(`${label}unknown check kind '${ch.kind}' in the case file`);
      }
    } catch (err) {
      problems.push(`${label}check '${ch.kind}' could not be evaluated: ${err.message}`);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// one result entry against one case
// ------------------------------------------------------------------------------------------------

function checkEntry(caseDef, entry, tolDefault, warnings) {
  const problems = [];
  const warn = (m) => warnings.push(m);
  const exp = caseDef.expect || {};
  const soft = new Set(exp.soft || []);
  const tol = { ...tolDefault, ...(caseDef.tol || {}) };
  const note = (kind, msg) => { if (soft.has(kind)) warn(`${kind}: ${msg}`); else problems.push(msg); };

  // shape
  for (const k of ['mapping', 'supported', 'status', 'algorithm', 'conflicting', 'redundant', 'partially_redundant', 'geometry']) {
    if (entry[k] === undefined) problems.push(`result entry has no field '${k}'`);
  }
  if (!['yes', 'partial', 'no'].includes(entry.supported)) problems.push(`supported must be yes|partial|no, got '${entry.supported}'`);
  if (problems.length) return problems;

  const steps = caseDef.steps || [];
  const solvedExpected = exp.solved !== false;
  const statusOk = exp.status_ok || ['Success'];

  // Cases with steps carry their expectations per step (see checkSteps); the global ones only apply
  // to cases without steps.
  if (steps.length > 0) {
    checkSteps(caseDef, entry, steps, tol, problems);
    return problems;
  }

  // status
  if (solvedExpected) {
    if (!statusOk.includes(entry.status)) note('status', `status '${entry.status}' not in [${statusOk}]`);
  } else if (entry.status === 'Success') {
    problems.push(`status 'Success' although the case has no solution (conflict expected)`);
  }

  // id sets (global, last state)
  const sets = [['conflicting', entry.conflicting], ['redundant', entry.redundant], ['partially_redundant', entry.partially_redundant]];
  for (const [name, actual] of sets) {
    const msg = checkSet(name, actual || [], exp[name]);
    if (msg) note(name, msg);
  }
  // a non-driving constraint must never be named
  const nondriving = new Set(caseDef.constraints.filter((c) => c.driving === false).map((c) => c.id));
  for (const [name, actual] of sets) for (const id of actual || []) if (nondriving.has(id)) problems.push(`non-driving constraint ${id} is reported as ${name}`);

  // dof
  if (exp.dof !== undefined && exp.dof !== null) {
    if (!isNum(entry.dof)) note('dof', `no dof reported (expected ${exp.dof})`);
    else if (entry.dof !== exp.dof) note('dof', `dof ${entry.dof}, expected ${exp.dof}`);
  }

  const initialCtx = new Ctx(caseDef, Object.fromEntries(caseDef.elements.filter((e) => e.type === 'point').map((e) => [e.id, { x: e.x, y: e.y }])));

  if (solvedExpected) {
    {
      const ctx = checkGeometry({ caseDef, geometry: entry.geometry, drivenValues: entry.driven_values, state: effectiveState(caseDef, 0), tol, label: '', problems });
      if (ctx) runExtraChecks(exp.checks, { caseDef, ctx, initialCtx, tol, label: '', problems });
      if (ctx && exp.driven) for (const [id, v] of Object.entries(exp.driven)) {
        const got = entry.driven_values?.[id];
        const c = caseDef.constraints.find((x) => x.id === id);
        const t = c && isAngular(c.type) ? tol.angle : tol.length;
        if (!isNum(got) || Math.abs(c && isAngular(c.type) ? wrapPi(got - v) : got - v) > t) problems.push(`driven value of ${id} is ${got}, expected ${v}`);
      }
    }
  }
  return problems;
}

function checkSteps(caseDef, entry, steps, tol, problems) {
  const rs = entry.steps;
  if (!Array.isArray(rs) || rs.length !== steps.length + 1) {
    problems.push(`result has ${Array.isArray(rs) ? rs.length : 0} steps, the case needs ${steps.length + 1} (step 0 = initial solve)`);
    return;
  }
  const exp = caseDef.expect || {};
  const prevCtx = [];
  for (let k = 0; k <= steps.length; k++) {
    const label = `step ${k}: `;
    const r = rs.find((x) => x.step === k);
    if (!r) { problems.push(`${label}missing in result`); continue; }
    const stepDef = k > 0 ? steps[k - 1] : {};
    const se = stepDef.expect || (k === 0 ? exp.step0 || {} : {});
    const state = effectiveState(caseDef, k);
    const local = [];
    const ctx = checkGeometry({ caseDef, geometry: r.geometry || {}, drivenValues: r.driven_values || entry.driven_values, state, tol, label: '', problems: local, skipConstraints: se.solved === false });
    // status per step
    if (se.solved === false) {
      if (r.status === 'Success') local.push(`status 'Success' but this step has no solution`);
    } else if (r.status !== undefined && !(se.status_ok || exp.status_ok || ['Success']).includes(r.status)) {
      local.push(`status '${r.status}' not in [${se.status_ok || exp.status_ok || ['Success']}]`);
    }
    const wantDof = se.dof !== undefined ? se.dof : (k === 0 && exp.step0 && exp.step0.dof !== undefined ? exp.step0.dof : exp.dof);
    if (wantDof !== undefined && wantDof !== null && se.solved !== false) {
      if (!isNum(r.dof)) local.push(`no dof reported for this step (expected ${wantDof})`);
      else if (r.dof !== wantDof) local.push(`dof ${r.dof}, expected ${wantDof}`);
    }
    for (const nm of ['conflicting', 'redundant', 'partially_redundant']) {
      if (se[nm] !== undefined || r[nm] !== undefined) {
        const m = checkSet(nm, r[nm] || [], se[nm]);
        if (m) local.push(m);
      }
    }
    if (ctx && se.solved !== false) {
      if (se.points) for (const [pid, xy] of Object.entries(se.points)) {
        const p = ctx.P(pid);
        const d = Math.hypot(p[0] - xy[0], p[1] - xy[1]);
        const t = se.tol ?? tol.length;
        if (d > t) local.push(`point ${pid} is at (${p[0].toFixed(6)},${p[1].toFixed(6)}) but should be at (${xy[0].toFixed(6)},${xy[1].toFixed(6)}) (off by ${d.toExponential(2)}, tolerance ${t})`);
      }
      runExtraChecks([...(caseDef.step_checks || []), ...(se.checks || [])], { caseDef, ctx, tol, label: '', problems: local });
      // jump detection against the previous step
      const prev = prevCtx[k - 1];
      if (prev) for (const ch of caseDef.step_checks || []) {
        if (ch.kind !== 'max_jump') continue;
        for (const pid of ch.points) {
          const a = prev.P(pid), b = ctx.P(pid);
          const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
          if (d > ch.max) local.push(`point ${pid} jumped ${d.toFixed(4)} between step ${k - 1} and ${k} (limit ${ch.max}): flip or mirror`);
        }
      }
    }
    prevCtx[k] = ctx;
    for (const m of local) problems.push(`${label}${m}`);
  }
  // the case-level geometry must be the last step
  const last = rs.find((x) => x.step === steps.length);
  if (last && entry.geometry) {
    for (const e of caseDef.elements) {
      if (e.type !== 'point') continue;
      const a = entry.geometry[e.id], b = last.geometry?.[e.id];
      if (a && b && Math.hypot(a.x - b.x, a.y - b.y) > 1e-9) { problems.push(`case-level geometry differs from the last step at point ${e.id}`); break; }
    }
  }
}

// ------------------------------------------------------------------------------------------------
// result file shape
// ------------------------------------------------------------------------------------------------

function checkShape(res) {
  const errs = [];
  for (const k of ['track', 'solver', 'build', 'runtime', 'run_date', 'timing_method', 'cases']) {
    if (res[k] === undefined) errs.push(`result file has no field '${k}'`);
  }
  if (res.track && !['salusoft-wasm', 'native-msvc', 'own-emscripten', 'selftest'].includes(res.track)) errs.push(`unknown track '${res.track}'`);
  if (res.build) for (const k of ['compiler', 'flags', 'eigen', 'boost', 'other']) if (res.build[k] === undefined) errs.push(`build has no field '${k}'`);
  if (!Array.isArray(res.cases)) errs.push('cases must be an array');
  return errs;
}

// ------------------------------------------------------------------------------------------------
// main
// ------------------------------------------------------------------------------------------------

export function runCheck(casesFile, resultFile, opts = {}) {
  const doc = loadCases(casesFile);
  const res = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  const tol = { ...DEFAULT_TOL, ...(doc.tolerances || {}), ...(opts.tol || {}) };
  const only = opts.only ? new Set(opts.only) : null;
  const shapeErrors = checkShape(res);
  const lines = [];
  const results = [];
  const knownIds = new Set(doc.cases.map((c) => c.id));

  for (const caseDef of doc.cases) {
    if (only && !only.has(caseDef.id)) continue;
    const wanted = caseDef.run_algorithms && caseDef.run_algorithms.length ? caseDef.run_algorithms : null;
    const entries = (res.cases || []).filter((e) => e.id === caseDef.id);
    if (entries.length === 0) {
      results.push({ id: caseDef.id, algorithm: '-', verdict: 'FAIL', reasons: ['no result entry'], warnings: [] });
      continue;
    }
    const algos = wanted || [null];
    for (const alg of algos) {
      const entry = alg ? entries.find((e) => e.algorithm === alg) : entries[0];
      if (!entry) {
        results.push({ id: caseDef.id, algorithm: alg, verdict: 'FAIL', reasons: [`no result entry for algorithm ${alg}`], warnings: [] });
        continue;
      }
      if (entry.supported === 'no') {
        results.push({ id: caseDef.id, algorithm: entry.algorithm, verdict: 'SKIP', reasons: [`not supported: ${entry.notes || entry.mapping || ''}`.trim()], warnings: [] });
        continue;
      }
      const warnings = [];
      let problems;
      try { problems = checkEntry(caseDef, entry, tol, warnings); }
      catch (err) { problems = [`checker error: ${err.stack || err.message}`]; }
      results.push({ id: caseDef.id, algorithm: entry.algorithm, verdict: problems.length ? 'FAIL' : 'PASS', reasons: problems, warnings, supported: entry.supported });
    }
  }
  for (const e of res.cases || []) if (!knownIds.has(e.id) && !(only)) results.push({ id: e.id, algorithm: e.algorithm, verdict: 'FAIL', reasons: ['result entry for an unknown case id'], warnings: [] });

  const count = (v) => results.filter((r) => r.verdict === v).length;
  const summary = { pass: count('PASS'), fail: count('FAIL'), skip: count('SKIP'), warn: results.filter((r) => r.warnings.length).length, total: results.length, shapeErrors };
  return { results, summary, tol, track: res.track };
}

function main() {
  const args = process.argv.slice(2);
  const pos = [];
  const opt = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const name = args[i];
      if (['--json', '--quiet'].includes(name)) opt[name] = true;
      else opt[name] = args[++i];
    } else pos.push(args[i]);
  }
  const flag = (n) => opt[n] === true;
  const val = (n) => (typeof opt[n] === 'string' ? opt[n] : undefined);
  if (pos.length < 2) {
    console.error('usage: node check/check.mjs <cases.json> <result.json> [--only id,id] [--tol-length x] [--tol-angle x] [--tol-curvature x] [--json] [--quiet]');
    process.exit(2);
  }
  const tol = {};
  if (val('--tol-length')) tol.length = Number(val('--tol-length'));
  if (val('--tol-angle')) tol.angle = Number(val('--tol-angle'));
  if (val('--tol-curvature')) tol.curvature = Number(val('--tol-curvature'));
  const only = val('--only') ? val('--only').split(',') : null;
  const { results, summary, tol: usedTol, track } = runCheck(pos[0], pos[1], { only, tol });
  if (flag('--json')) {
    console.log(JSON.stringify({ track, tolerances: usedTol, summary, results }, null, 2));
  } else {
    for (const r of results) {
      const tag = r.algorithm && r.algorithm !== '-' ? ` [${r.algorithm}]` : '';
      if (r.verdict === 'PASS' && flag('--quiet')) continue;
      console.log(`${r.verdict.padEnd(4)}  ${r.id}${tag}${r.verdict === 'FAIL' || r.verdict === 'SKIP' ? ': ' + r.reasons.join(' | ') : ''}${r.warnings.length ? `  (warn: ${r.warnings.join(' | ')})` : ''}`);
    }
    for (const e of summary.shapeErrors) console.log(`FORMAT  ${e}`);
    console.log(`\ntolerances: length ${usedTol.length} mm, angle ${usedTol.angle} rad, curvature ${usedTol.curvature} 1/mm`);
    console.log(`summary: ${summary.pass} PASS, ${summary.fail} FAIL, ${summary.skip} SKIP, ${summary.warn} with warnings, ${summary.total} entries${summary.shapeErrors.length ? `, ${summary.shapeErrors.length} format error(s)` : ''}`);
  }
  process.exit(summary.fail === 0 && summary.shapeErrors.length === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
