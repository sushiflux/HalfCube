# Track `salusoft-wasm`

Runs the solver-neutral case catalogue (`../cases/cases.json`) against the prebuilt npm package
`@salusoft89/planegcs` (WebAssembly build of FreeCAD's planegcs plus a TypeScript wrapper) under Node.js and
writes `spikes/solvertest/_results/salusoft-wasm.json`. Throwaway spike, not part of the product.

## Setup

The package is already installed here (exact version `1.3.0`, no dependencies, installed with
`--ignore-scripts`; see `package.json` and `package-lock.json`). On a fresh clone, from this folder:

```
npm install --ignore-scripts
```

(or run `spikes/solvertest/fetch-deps.ps1`, which does this and fetches the other sources). Nothing is
installed globally. Node.js (the run in the notes used v26.13.1; other versions not tried).

## Run

From the repository root:

```
node spikes/solvertest/salusoft/run.mjs
node spikes/solvertest/check/check.mjs spikes/solvertest/cases/cases.json spikes/solvertest/_results/salusoft-wasm.json > spikes/solvertest/_results/salusoft-wasm.check.txt
```

The full run takes about 5 seconds (all 100 result entries, one fresh WebAssembly module each).

Options of `run.mjs`:

| Option | Meaning |
|---|---|
| `--only id,id` | run only these cases; the result then goes to `spikes/solvertest/_build/salusoft-wasm.partial.json` |
| `--runs N` | number of timed runs after the warm-up run (default 5) |
| `--out file` | write the result somewhere else |
| `--no-iterations` | skip the iteration count (it uses the package's IterationLevel debug output) |

## Files

| File | Purpose |
|---|---|
| `translate.mjs` | translates the neutral case (elements, constraints, steps) into the package's JSON primitives; never calls the solver and never reads the case's `expect` |
| `run.mjs` | loads the package, solves, diagnoses, times, writes the result file |
| `probe.mjs` | extra experiments that back statements in the notes (not part of the result file) |

Probe commands (output saved in `spikes/solvertest/_results/salusoft-wasm.probes.txt`):

```
node spikes/solvertest/salusoft/probe.mjs scaling
node spikes/solvertest/salusoft/probe.mjs bspline-helpers
node spikes/solvertest/salusoft/probe.mjs repeat
```

## How a case is run

1. Pass 1: build the system from the (deliberately off) start geometry, `solve(algorithm)`, `apply_solution()`,
   read geometry and the values of non-driving dimensions. Timed.
2. Pass 2: rebuild the system from the solved geometry and call `solve()` once more; the solver diagnoses at
   that state, then `dof()`, conflicting, redundant and partially redundant lists are read (protocol of
   `../CASES.md` section 1). Constraint ids from the package's primitive ids are mapped back to the case's
   constraint ids; a case constraint is `redundant` when all its package constraints are, otherwise
   `partially_redundant`.
3. Steps: step `k` starts from the geometry of step `k-1`; a drag is two temporary `coordinate_x/y` constraints
   (tag -1, solved by the package with SQP) that are not kept.

## Timing

One warm-up run (it also produces the diagnosis and the iteration count), then 5 timed runs, each on a freshly
built system. `time_ms_median` is the median wall-clock time of the wrapper's `solve()` call alone
(`GcsSystem.solve_system`, which includes the solver's own initialisation and diagnosis); pushing the primitives
into the wasm system (`time_build_ms_median`) and the total including reading the result back
(`time_total_ms_median`) are extra fields. For step sequences the value is the sum over all steps of one run;
`steps[].time_ms` is the median over the runs for that step. A case whose first timed run takes more than 3 s
gets a single timed run (none did). Each result entry uses its own WebAssembly module instance.

## Things the runner has to work around

- The module writes to `console.log` (also unconditional "Sketcher Redundant solving" lines); the runner
  replaces `console.log`/`console.error` before the first module is created and swallows the output (it is
  only kept while counting iterations).
- Free sketch parameters (curve parameter of `point_on_bspline`) must be pushed with `push_sketch_param(name,
  value, false)`; `push_primitives_and_params` pushes them fixed.
- After a WebAssembly abort (out of memory) the module is unusable; the runner records the abort and goes on
  with a new module for the next entry.
