#!/usr/bin/env node
// Writes check/selftest-result.json: a tiny result file made by hand / by closed-form formulas (NO
// solver involved). Some entries are correct, some are deliberately wrong. selftest.mjs checks that
// the checker gives exactly the expected verdict for every entry.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const P = (x, y) => ({ x, y });

function E(id, o = {}) {
  return {
    id, mapping: 'hand-made', supported: 'yes', status: 'Success', algorithm: 'DogLeg', iterations: null,
    time_ms_median: null, dof: null, conflicting: [], redundant: [], partially_redundant: [], geometry: {},
    driven_values: {}, steps: [], notes: '', ...o,
  };
}

const cases = [];

// PASS: horizontal line solved correctly
cases.push(E('K01a-horizontal-line', { dof: 3, geometry: { P1: P(0, 0), P2: P(10, 0) } }));
// FAIL: vertical constraint not solved (start coordinates returned)
cases.push(E('K01b-vertical-line', { dof: 3, geometry: { P1: P(0, 0), P2: P(3, 10) } }));
// PASS: coincident points
cases.push(E('K02a-coincident-points', { dof: 2, geometry: { P1: P(2.5, 2), P2: P(2.5, 2) } }));
// FAIL: second line not parallel to the first (start geometry returned)
cases.push(E('K05a-parallel-one-free', { dof: 1, geometry: { P1: P(0, 0), P2: P(10, 1), P3: P(0, 5), P4: P(8, 8) } }));
// PASS: 3-4-5 distance 10
cases.push(E('D01-distance-point-point', { dof: 1, geometry: { P1: P(0, 0), P2: P(6, 8) } }));
// FAIL: geometry right, dof wrong
cases.push(E('D03-distance-horizontal', { dof: 2, geometry: { P1: P(0, 0), P2: P(12, 5) } }));
// FAIL: conflict named incompletely (c2 missing) although status is right
cases.push(E('C01-contradicting-lengths', { status: 'Failed', conflicting: ['c1'], geometry: { P1: P(0, 0), P2: P(10, 0.5) } }));
// FAIL: reported driven value (9) differs from what the geometry measures (10)
cases.push(E('N01-nondriving-distance', { dof: 0, geometry: { P1: P(0, 0), P2: P(6, 8) }, driven_values: { c3: 9 } }));
// PASS: correct non-driving length
cases.push(E('N05-nondriving-length', { dof: 0, geometry: { P1: P(0, 0), P2: P(3, 4) }, driven_values: { c3: 5 } }));
// SKIP: not supported
cases.push(E('K12b-curvature-arc-bspline', { supported: 'no', status: 'unsupported', notes: 'no curvature constraint' }));
// algorithm variants: DogLeg and LevenbergMarquardt correct, BFGS missing -> FAIL for BFGS
const k03c = { dof: 1, geometry: { O1: P(0, 0), O2: P(8, 0), C1: { radius: 5 }, C2: { radius: 3 } } };
cases.push(E('K03c-tangent-circle-circle-external', { ...k03c, algorithm: 'DogLeg' }));
cases.push(E('K03c-tangent-circle-circle-external', { ...k03c, algorithm: 'LevenbergMarquardt' }));
// PASS with a warning: unsolvable triangle, conflict not named (soft expectation)
cases.push(E('C03-contradicting-triangle', { status: 'Failed', dof: null, geometry: { P1: P(0, 0), P2: P(3, 0), P3: P(2.2, 0.0) } }));
// PASS: point on the rational quarter circle (radius 5 at 40 degrees); tests weights in the checker
{
  const a = (40 * Math.PI) / 180;
  cases.push(E('B07-rational-quarter-circle', {
    dof: 1,
    geometry: { O: P(0, 0), P1: P(5, 0), P2: P(5, 5), P3: P(0, 5), Pt: P(5 * Math.cos(a), 5 * Math.sin(a)) },
  }));
}
// FAIL: triangle sweep where the apex flips below the base at step 5 (closed-form positions)
{
  const stepsOf = (flipAt) => Array.from({ length: 10 }, (_, k) => {
    const L = 10 * (k + 1);
    const x = 100 - (L * L) / 200;
    const y = Math.sqrt(10000 - x * x) * (k >= flipAt ? -1 : 1);
    return { step: k, status: 'Success', dof: 0, geometry: { P1: P(0, 0), P2: P(100, 0), P3: P(x, y) } };
  });
  const s = stepsOf(5);
  cases.push(E('S01-triangle-side-sweep', { dof: 0, geometry: s[9].geometry, steps: s }));
}
// PASS: circle tangent to a line with growing radius (closed form: centre (0, r))
{
  const s = Array.from({ length: 10 }, (_, k) => {
    const r = k === 0 ? 5 : 10 + (k - 1) * 5;
    return { step: k, status: 'Success', dof: 0, geometry: { A: P(-100, 0), B: P(100, 0), M: P(0, 0), C: P(0, r), K1: { radius: r } } };
  });
  cases.push(E('S03-circle-tangent-radius-sweep', { dof: 0, geometry: s[9].geometry, steps: s }));
}
// FAIL (format): required field missing
{
  const e = E('K04a-equal-length', { dof: 3, geometry: { P1: P(0, 0), P2: P(10, 2), P3: P(0, 5), P4: P(6, 8) } });
  delete e.status;
  cases.push(e);
}

const result = {
  track: 'selftest',
  solver: 'none (hand-made / closed-form values, used to test the checker)',
  build: { compiler: 'none', flags: '', eigen: 'none', boost: 'none', other: '' },
  runtime: process.version,
  run_date: '2026-11-24',
  timing_method: 'none',
  cases,
};
fs.writeFileSync(path.join(here, 'selftest-result.json'), JSON.stringify(result, null, 1));
console.log(`wrote selftest-result.json with ${cases.length} entries`);
