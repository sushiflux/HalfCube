#!/usr/bin/env node
// Compares two result files of the solver test case by case: status, algorithm, iterations, DOF, diagnosis lists,
// solved geometry (largest absolute difference of any number), non-driving values and the solve times.
// Usage: node compare-tracks.mjs <a.json> <b.json> [--json]
import fs from 'node:fs';

const [fa, fb] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
if (!fa || !fb) { console.error('usage: compare-tracks.mjs <a.json> <b.json> [--json]'); process.exit(2); }
const A = JSON.parse(fs.readFileSync(fa, 'utf8'));
const B = JSON.parse(fs.readFileSync(fb, 'utf8'));
const key = (c) => `${c.id}|${c.algorithm}`;
const mb = new Map(B.cases.map((c) => [key(c), c]));

function maxDiff(x, y, path = '') {
  // returns { d, at }: largest absolute difference of numbers at equal positions, Infinity for shape mismatch
  if (typeof x === 'number' && typeof y === 'number') return { d: Math.abs(x - y), at: path };
  if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) return { d: Infinity, at: `${path} (length)` };
    let best = { d: 0, at: '' };
    x.forEach((v, i) => { const r = maxDiff(v, y[i], `${path}[${i}]`); if (r.d > best.d) best = r; });
    return best;
  }
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    const keys = new Set([...Object.keys(x), ...Object.keys(y)].filter((k) => !k.startsWith('time')));  // timings differ by nature
    let best = { d: 0, at: '' };
    for (const k of keys) {
      if (!(k in x) || !(k in y)) return { d: Infinity, at: `${path}.${k} (missing)` };
      const r = maxDiff(x[k], y[k], `${path}.${k}`); if (r.d > best.d) best = r;
    }
    return best;
  }
  return x === y ? { d: 0, at: '' } : { d: Infinity, at: `${path} (value)` };
}
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

const rows = [];
const diffs = [];
for (const a of A.cases) {
  const b = mb.get(key(a));
  if (!b) { diffs.push({ id: a.id, what: 'missing in b' }); continue; }
  const g = maxDiff(a.geometry ?? {}, b.geometry ?? {});
  const s = maxDiff(a.steps ?? [], b.steps ?? []);
  const v = maxDiff(a.driven_values ?? {}, b.driven_values ?? {});
  const d = { id: a.id, alg: a.algorithm };
  if (a.status !== b.status) d.status = [a.status, b.status];
  if (a.iterations !== b.iterations) d.iterations = [a.iterations, b.iterations];
  if (a.dof !== b.dof) d.dof = [a.dof, b.dof];
  for (const f of ['conflicting', 'redundant', 'partially_redundant']) if (!same(a[f], b[f])) d[f] = [a[f], b[f]];
  if (g.d > 0) d.geometry = { max_abs_diff: g.d, at: g.at };
  if (s.d > 0) d.steps = { max_abs_diff: s.d, at: s.at };
  if (v.d > 0) d.driven_values = { max_abs_diff: v.d, at: v.at };
  if (Object.keys(d).length > 2) diffs.push(d);
  rows.push({ id: a.id, alg: a.algorithm, ta: a.time_ms_median, tb: b.time_ms_median,
    pa: a.time_ms_parts, pb: b.time_ms_parts });
}
const out = { a: fa.split(/[\/]/).pop(), b: fb.split(/[\/]/).pop(), compared: rows.length, with_differences: diffs.length, diffs, times: rows };
if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
console.log(`${out.a} vs ${out.b}: ${rows.length} entries compared, ${diffs.length} with differences`);
for (const d of diffs) console.log(JSON.stringify(d));
const ratio = rows.filter((r) => r.ta > 0 && r.tb > 0).map((r) => r.tb / r.ta).sort((x, y) => x - y);
const med = (arr) => arr[Math.floor(arr.length / 2)];
console.log(`time ratio b/a over ${ratio.length} entries: median ${med(ratio).toFixed(2)}, min ${ratio[0].toFixed(2)}, max ${ratio.at(-1).toFixed(2)}`);
for (const r of rows.filter((r) => /^(P0|S0|T02|C06)/.test(r.id))) {
  console.log(`${r.id} [${r.alg}]: a ${r.ta} ms, b ${r.tb} ms, b/a ${(r.tb / r.ta).toFixed(2)}`);
}
