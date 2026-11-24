// Loads the WebAssembly build of the kernel test in Node.js, measures size and start-up, runs it and records the
// peak linear memory.
//   node run-node.mjs <dir with kerntest_occt.js/.wasm> <report.json> -- <kerntest arguments>
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants as zc } from 'node:zlib';
import path from 'node:path';

const [dir, reportPath, sep, ...ktArgs] = process.argv.slice(2);
if (!dir || !reportPath || sep !== '--') {
  console.error('usage: node run-node.mjs <build dir> <report.json> -- <kerntest arguments>');
  process.exit(2);
}
const jsPath = path.resolve(dir, 'kerntest_occt.js');
const wasmPath = path.resolve(dir, 'kerntest_occt.wasm');

function sizes(file) {
  const buf = readFileSync(file);
  return {
    raw_bytes: buf.length,
    gzip9_bytes: gzipSync(buf, { level: 9 }).length,
    brotli11_bytes: brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length,
  };
}

const report = { node: process.version, v8: process.versions.v8, wasm: sizes(wasmPath), glue_js: sizes(jsPath) };

const require = createRequire(import.meta.url);
const t0 = performance.now();
const factory = require(jsPath);
const mod = await factory({
  print: (s) => process.stdout.write(s + '\n'),
  printErr: (s) => process.stderr.write(s + '\n'),
});
report.instantiate_ms = performance.now() - t0;
report.initial_memory_bytes = mod.HEAPU8.length;

const t1 = performance.now();
let rc;
try {
  rc = mod.callMain(ktArgs);
} catch (e) {
  report.error = String(e && e.stack || e);
}
report.call_main_ms = performance.now() - t1;
report.exit_code = rc;
// Linear memory only grows, so its size after the run is the peak.
report.peak_memory_bytes = mod.HEAPU8.length;
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.error(`wrote ${reportPath}`);
