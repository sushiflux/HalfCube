#!/usr/bin/env node
// Self-test of the checker: runs it on selftest-result.json and verifies that every entry gets exactly
// the expected verdict (correct input PASS, wrong input FAIL, unsupported SKIP). Exit code 0 only if
// all expectations hold. Usage: node check/selftest.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runCheck } from './check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const casesFile = path.join(here, '..', 'cases', 'cases.json');
const resultFile = path.join(here, 'selftest-result.json');

// the expected verdicts: key = id[algorithm]; a substring of the reasons that must appear for FAIL
const expected = {
  'K01a-horizontal-line': { verdict: 'PASS' },
  'K01b-vertical-line': { verdict: 'FAIL', reason: 'constraint c1 (vertical) violated' },
  'K02a-coincident-points': { verdict: 'PASS' },
  'K05a-parallel-one-free': { verdict: 'FAIL', reason: 'constraint c1 (parallel) violated' },
  'D01-distance-point-point': { verdict: 'PASS' },
  'D03-distance-horizontal': { verdict: 'FAIL', reason: 'dof 2, expected 1' },
  'C01-contradicting-lengths': { verdict: 'FAIL', reason: 'conflicting expected exactly [c1,c2] but is [c1]' },
  'N01-nondriving-distance': { verdict: 'FAIL', reason: 'reported 9 but the geometry measures 10' },
  'N05-nondriving-length': { verdict: 'PASS' },
  'K12b-curvature-arc-bspline': { verdict: 'SKIP' },
  'K03c-tangent-circle-circle-external[DogLeg]': { verdict: 'PASS' },
  'K03c-tangent-circle-circle-external[LevenbergMarquardt]': { verdict: 'PASS' },
  'K03c-tangent-circle-circle-external[BFGS]': { verdict: 'FAIL', reason: 'no result entry for algorithm BFGS' },
  'C03-contradicting-triangle': { verdict: 'PASS', warn: true },
  'B07-rational-quarter-circle': { verdict: 'PASS' },
  'S01-triangle-side-sweep': { verdict: 'FAIL', reason: 'orientation of [P1,P2,P3] flipped' },
  'S03-circle-tangent-radius-sweep': { verdict: 'PASS' },
  'K04a-equal-length': { verdict: 'FAIL', reason: "no field 'status'" },
};

const only = [...new Set(Object.keys(expected).map((k) => k.replace(/\[.*\]$/, '')))];
const { results, summary } = runCheck(casesFile, resultFile, { only });
let bad = 0;
const seen = new Set();
for (const r of results) {
  const key = r.algorithm && r.algorithm !== '-' && Object.keys(expected).some((k) => k.startsWith(`${r.id}[`)) ? `${r.id}[${r.algorithm}]` : r.id;
  seen.add(key);
  const exp = expected[key];
  if (!exp) { console.log(`UNEXPECTED entry ${key}: ${r.verdict}`); bad++; continue; }
  let ok = r.verdict === exp.verdict;
  if (ok && exp.reason) ok = r.reasons.some((m) => m.includes(exp.reason));
  if (ok && exp.warn) ok = r.warnings.length > 0;
  console.log(`${ok ? 'ok  ' : 'BAD '} ${key}: got ${r.verdict}${r.reasons.length ? ` (${r.reasons[0].slice(0, 110)})` : ''}, expected ${exp.verdict}${exp.reason ? ` containing "${exp.reason}"` : ''}`);
  if (!ok) bad++;
}
for (const key of Object.keys(expected)) if (!seen.has(key)) { console.log(`MISSING verdict for ${key}`); bad++; }

// the checker must also exit non-zero on the wrong input, zero on a file without FAIL
const cli = spawnSync(process.execPath, [path.join(here, 'check.mjs'), casesFile, resultFile, '--only', only.join(','), '--quiet'], { encoding: 'utf8' });
if (cli.status === 0) { console.log('BAD  command line exit code is 0 although FAIL entries exist'); bad++; } else console.log(`ok   command line exit code is ${cli.status} for the wrong input`);

console.log(`\nselftest: ${bad === 0 ? 'all expectations hold' : `${bad} problem(s)`} (${summary.total} entries checked)`);
process.exit(bad === 0 ? 0 : 1);
