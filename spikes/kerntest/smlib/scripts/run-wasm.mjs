// Runs the WebAssembly build of the kernel test under Node.js with the same command line
// as the native program, and adds WebAssembly measurements to the JSON it writes:
//   node run-wasm.mjs path/to/smlib_kerntest.js [--runs N] [--out DIR] [--json FILE] [CASE ...]
// instantiate_ms: time from calling the module factory until the module is ready
//                 (compile + instantiate + static constructors);
// peakLinearMemory_bytes: linear memory size after the run (it only ever grows).
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const [jsFile, ...args] = process.argv.slice(2);
if (!jsFile) {
    console.error('usage: node run-wasm.mjs smlib_kerntest.js [kerntest arguments]');
    process.exit(2);
}
const require = createRequire(import.meta.url);
const t0 = performance.now();
const factory = require(resolve(jsFile));
const mod = await factory();
const instantiateMs = performance.now() - t0;
const initialMem = mod.HEAPU8.length;

if (args.includes('--list')) {
    mod.callMain(args);
    process.exit(0);
}
const t1 = performance.now();
let rc = 0;
try {
    rc = mod.callMain(args);
} catch (e) {
    console.error(`[run-wasm] callMain threw: ${e && e.stack ? e.stack : e}`);
    rc = 1;
}
const runMs = performance.now() - t1;
const jsonIdx = args.indexOf('--json');
const jsonPath = jsonIdx >= 0 ? args[jsonIdx + 1] : 'smlib_kerntest.json';
const wasmPath = resolve(jsFile).replace(/\.js$/, '.wasm');
const stats = {
    node: process.version,
    instantiate_ms: instantiateMs,
    callMain_ms: runMs,
    initialLinearMemory_bytes: initialMem,
    peakLinearMemory_bytes: mod.HEAPU8.length,
    wasm_bytes: existsSync(wasmPath) ? statSync(wasmPath).size : null,
    glue_js_bytes: statSync(resolve(jsFile)).size,
};
if (existsSync(jsonPath)) {
    const doc = JSON.parse(readFileSync(jsonPath, 'utf8'));
    doc.wasm = stats;
    writeFileSync(jsonPath, JSON.stringify(doc) + '\n');
}
console.error(`[run-wasm] ${JSON.stringify(stats)}`);
process.exit(typeof rc === 'number' ? rc : 0);
