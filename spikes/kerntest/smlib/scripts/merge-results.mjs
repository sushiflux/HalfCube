// Merges the per-case JSON files written by smlib_kerntest (one process per case) into one
// document. A case whose process died without writing JSON is recorded as a crash.
//   node merge-results.mjs OUT.json CASE_DIR CASE1 CASE2 ...
// CASE_DIR holds <case>.json and optionally <case>.exit (process exit code as text).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [out, dir, ...cases] = process.argv.slice(2);
if (!out || !dir || cases.length === 0) {
    console.error('usage: node merge-results.mjs OUT.json CASE_DIR CASE...');
    process.exit(2);
}
let header = null;
const merged = [];
for (const id of cases) {
    const jf = join(dir, `${id}.json`);
    const ef = join(dir, `${id}.exit`);
    const exit = existsSync(ef) ? readFileSync(ef, 'utf8').trim() : 'unknown';
    if (existsSync(jf)) {
        const doc = JSON.parse(readFileSync(jf, 'utf8'));
        if (!header) {
            header = { ...doc };
            delete header.cases;
            delete header.wasm;
        }
        for (const c of doc.cases) merged.push({ ...c, processExitCode: exit, ...(doc.wasm ? { wasm: doc.wasm } : {}) });
    } else {
        merged.push({ id, outcome: 'fail-clean', detail: `process ended without results (exit code ${exit}): crash or abort inside the kernel`, processExitCode: exit });
    }
}
writeFileSync(out, JSON.stringify({ ...(header ?? {}), cases: merged }, null, 2) + '\n');
console.log(`merged ${merged.length} case(s) into ${out}`);
