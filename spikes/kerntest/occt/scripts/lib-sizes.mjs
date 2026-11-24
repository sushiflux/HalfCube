// Sizes of the OCCT toolkits the kernel test needs, split into "core" (P1 to P4) and "STEP only".
// The dependency closure comes from OCCT's own EXTERNLIB.cmake files.
//   node lib-sizes.mjs <occt source dir> <library dir | listing file> <dll|so|a> [out.json]
// A listing file has one "<size in bytes> <file name>" pair per line (as written by the Docker scripts).
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const [srcDir, libDir, kind, outPath] = process.argv.slice(2);
if (!srcDir || !libDir || !kind) {
  console.error('usage: node lib-sizes.mjs <occt source dir> <library dir> <dll|so|a> [out.json]');
  process.exit(2);
}

// toolkit -> direct OCCT toolkit dependencies
const deps = new Map();
for (const mod of readdirSync(path.join(srcDir, 'src'))) {
  const modDir = path.join(srcDir, 'src', mod);
  if (!statSync(modDir).isDirectory()) continue;
  for (const tk of readdirSync(modDir)) {
    const f = path.join(modDir, tk, 'EXTERNLIB.cmake');
    if (!existsSync(f)) continue;
    const names = readFileSync(f, 'utf8').match(/\bTK[A-Za-z0-9]+\b/g) || [];
    deps.set(tk, [...new Set(names.filter((n) => n !== tk && !n.startsWith('TKernel_')))]);
  }
}
function closure(roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const t = stack.pop();
    if (seen.has(t)) continue;
    seen.add(t);
    for (const d of deps.get(t) || []) stack.push(d);
  }
  return [...seen].sort();
}

const isListing = statSync(libDir).isFile();
const listed = new Map();
if (isListing) {
  for (const line of readFileSync(libDir, 'utf8').split(String.fromCharCode(10))) {
    const m = line.trim().match(/^([0-9]+)[ \t]+(.+)$/);
    if (m) listed.set(path.basename(m[2]), Number(m[1]));
  }
}
const files = isListing ? [...listed.keys()] : readdirSync(libDir);
function fileOf(tk) {
  const pick = {
    dll: (f) => f === `${tk}.dll`,
    so: (f) => f.startsWith(`lib${tk}.so.`) && /\.so\.\d+\.\d+\.\d+$/.test(f),
    a: (f) => f === `lib${tk}.a`,
  }[kind];
  return files.find(pick);
}
function sum(list) {
  let total = 0;
  const per = {};
  for (const tk of list) {
    const f = fileOf(tk);
    if (!f) { per[tk] = null; continue; }
    const s = isListing ? listed.get(f) : statSync(path.join(libDir, f)).size;
    per[tk] = s;
    total += s;
  }
  return { total_bytes: total, per_toolkit_bytes: per };
}

const coreRoots = ['TKernel', 'TKMath', 'TKG2d', 'TKG3d', 'TKGeomBase', 'TKBRep', 'TKGeomAlgo', 'TKTopAlgo', 'TKPrim',
  'TKBO', 'TKShHealing', 'TKBool', 'TKFillet', 'TKOffset', 'TKMesh', 'TKHelix'];
const core = closure(coreRoots);
const stepAll = closure(['TKDESTEP']);
const coreAndStep = closure([...coreRoots, 'TKDESTEP']);
const stepOnly = coreAndStep.filter((t) => !core.includes(t));
const result = {
  kind,
  core_closure: core,
  step_closure: stepAll,
  step_only_beyond_core: stepOnly,
  core: sum(core),
  step_only: sum(stepOnly),
  step_alone_with_its_deps: sum(stepAll),
  core_plus_step: sum(coreAndStep),
};
const text = JSON.stringify(result, null, 2) + '\n';
if (outPath) writeFileSync(outPath, text); else process.stdout.write(text);
