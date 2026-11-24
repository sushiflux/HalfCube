# Solver test: constraint mapping, case format, case list

Sources read for this document: FreeCAD tag 1.1.4 (commit `4fd3bf32`, `src/Mod/Sketcher/App/planegcs/`
and `Sketch.cpp`) and the package `@salusoft89/planegcs` 1.3.0 (`sketch/gcs_wrapper.ts`,
`planegcs_dist/constraints.ts`, binding template `build-bindings/templates/gcs_system.cpp.njk` of the
GitHub repository). Line numbers refer to those files in `_deps/` and `salusoft/node_modules/`.
Everything marked "probe run" was observed while testing the catalogue itself (a throwaway runner
against the prebuilt package); it is a hint for the tracks, not a track result. What was not verified
is marked "not checked".

## 1. How planegcs is driven (facts the runners need)

**Native API** (`GCS::System`, `GCS.h`):

- Parameters are `double*`. `declareUnknowns(VEC_pD&)` (GCS.h:582) lists what the solver may change;
  `declareDrivenParams(VEC_pD&)` (GCS.h:583) lists the value parameters of non-driving constraints so
  that they are not counted as DOF. FreeCAD pushes the value of a non-driving dimension to both lists
  (`Sketch.cpp:1944`, `1956`).
- Every `addConstraint*` takes `tagId` and `driving` (GCS.h:266-561). The tag is what the diagnosis
  reports; several solver constraints may share one tag. Tag `0` = high priority, never reported;
  tag `< 0` = temporary (drag): solved in a second subsystem with SQP, does not take part in the
  diagnosis (`GCS.cpp:4502`, `1869-1916`, hints at `GCS.cpp:4743-4751`). `driving=false` constraints
  also go to that second subsystem (`GCS.cpp:1831-1836`).
- `solve(isFine, Algorithm, isRedundantsolving)` (GCS.h:586) returns `Success=0`, `Converged=1`,
  `Failed=2`, `SuccessfulSolutionInvalid=3` (GCS.h:52-59). `Algorithm`: `BFGS=0`,
  `LevenbergMarquardt=1`, `DogLeg=2` (GCS.h:61-66). With temporary constraints the algorithm argument
  is ignored (SQP). `applySolution()` (GCS.h:596) writes the result into the parameters.
- `diagnose(alg)` (GCS.h:608, `GCS.cpp:4738`) is called by `initSolution()` (`GCS.cpp:1711`) when there
  is no diagnosis yet. It decides **by the rank of the Jacobian at the current parameter values**, so
  redundancy and dependent constraints are only visible when the start geometry already satisfies
  them; the tag lists come from a heuristic that picks one constraint out of each dependent group
  (`GCS.cpp:5424-5600`, explanation in the comment at `GCS.cpp:5492-5510`). Results: `dofsNumber()` (GCS.h:609),
  `getConflicting`, `getRedundant`, `getPartiallyRedundant` (GCS.h:613-624). `dofs` for an
  over-determined system is `params - non-redundant constraints` (`GCS.cpp:4943`, `5024`).
- Defaults (`GCS.cpp:480-503`): `maxIter 100`, `convergence 1e-10`, `autoChooseAlgorithm true`,
  `autoQRThreshold 1000` (dense QR below 1000 parameters, sparse QR otherwise; the prebuilt package's
  older snapshot does not have these two fields and defaults to `EigenSparseQR`, `planegcs/GCS.cpp:481` of the wrapper repository).
- `diagnose` starts two QR decompositions with `std::async` (`GCS.cpp:4903`, `4980`); the prebuilt
  package patched out the `fut.wait()` (`planegcs/update_freecad.sh`). Relevant for our own
  Emscripten build (no threads).

**Salusoft wrapper** (`GcsWrapper`): geometry and constraints are JSON "primitives"; points must be
pushed before the lines/circles/arcs that use them (`sketch_index.get_sketch_point`), geometry before
constraints. Each primitive gets a tag = its 1-based position among all primitives
(`gcs_wrapper.ts` `push_constraint`, `sketch_index.ts` `get_id_by_index`), so the conflict / redundancy
lists come back as primitive ids. Facts from reading the source and the binding template:

- All parameters that are not `fixed` are passed as unknowns (`solve_system`); `declareDrivenParams`
  is never called (no occurrence in `build-bindings/`). For `driving:false` the value parameter is
  pushed non-fixed (`is_fixed = driving ?? true`, `push_constraint`), so it counts as an unknown.
  Probe run: DOF is one too high per non-driving dimension.
- B-spline: `make_bspline` creates the helper points `start`/`end` as new, non-fixed parameters that are
  not tied to the end poles (`gcs_wrapper.ts:460-495`), weights and knots are
  fixed parameters. Probe run: DOF is 4 too high for every B-spline that a constraint refers to as an object (the helpers are created then; splines used only through their pole points are fine); FreeCAD ties them with two
  coincident constraints (`Sketch.cpp:1585-1590`).
- `point_on_bspline.pointparam` as a plain number is pushed fixed (driving), i.e. the point would be
  pinned to `C(u0)`. A free curve parameter needs `push_sketch_param(name, value, false)` and the
  constraint referencing the name as a string.
- `temporary: true` gives tag `-1` (drag). Algorithm per solve: `solve(Algorithm)`; `Algorithm` enum values
  as in the native API.
- `dof()` exists on the raw `GcsSystem` only (`planegcs_dist/gcs_system.ts:67`), not on `GcsWrapper`.

**Diagnosis protocol for all tracks (so that results are comparable).** Every solve is done in two
passes: pass 1 solves from the (deliberately off) start geometry and gives `status`, geometry, timing
and `driven_values`; pass 2 rebuilds the system from the solved geometry and runs `diagnose`, giving
`dof`, `conflicting`, `redundant`, `partially_redundant`. This is what FreeCAD effectively does (it
diagnoses the geometry saved in the document, which already satisfies the old constraints). Pass 1's
own diagnosis may be reported in an optional field `diagnosis_at_start`. When a case has no solution
(`expect.solved = false`) pass 2 starts from the best-effort result of pass 1.

## 2. Mapping of the 12 Fusion constraint types

"direct" = one planegcs constraint does it, "composed" = several planegcs constraints (or auxiliary
geometry) are needed, "missing" = nothing in planegcs. Names in the last two columns: native function
(GCS.h line) and Salusoft primitive type.

| # | Fusion type | Native (planegcs `GCS::System`) | Salusoft primitive | Class |
|---|---|---|---|---|
| 1 | Horizontal / Vertical | `addConstraintHorizontal(Line&)` :396, `(Point&,Point&)` :397; `addConstraintVertical` :398/:399 | `horizontal_l`, `horizontal_pp`, `vertical_l`, `vertical_pp` | direct |
| 2a | Coincident point-point | `addConstraintP2PCoincident` :395 | `p2p_coincident` | direct |
| 2b | Coincident point-on-curve | line `addConstraintPointOnLine` :302/:303; circle `addConstraintPointOnCircle` :403; arc `addConstraintPointOnArc` :418 (**circle of the arc only**, `GCS.cpp:1009`, angular span not enforced); B-spline `addConstraintPointOnBSpline` :407 (needs the curve parameter as extra unknown) | `point_on_line_pl` / `_ppp`, `point_on_circle`, `point_on_arc`, `point_on_bspline` | direct |
| 3a | Tangent line-circle / line-arc | `addConstraintTangent(Line&,Circle&)` :443, `(Line&,Arc&)` :445 = point-line distance of the centre equal to the radius parameter (`GCS.cpp:1093-1109`) | `tangent_lc`, `tangent_la` | direct |
| 3b | Tangent circle/arc - circle/arc | `addConstraintTangent` :446-:448 -> `addConstraintTangentCircumf` :377; internal or external is decided **when the constraint is created**, from the current centre distance (`GCS.cpp:1111-1157`) | `tangent_cc`, `tangent_ca`, `tangent_aa` | direct (start-dependent) |
| 3c | Tangent at a shared end point (curve-curve) | `addConstraintP2PCoincident` :395 + `addConstraintAngleViaPoint` :332 with angle 0 or pi (FreeCAD `Sketch.cpp:3325-3331`) | `p2p_coincident` + `angle_via_point` | composed |
| 3d | Tangent line - B-spline | at an **interior** knot with multiplicity < degree: `addConstraintTangentAtBSplineKnot` :386 (+ knot point `addConstraintInternalAlignmentKnotPoint` :555, + point on line). At the **end** of a clamped spline FreeCAD refuses it (`Sketch.cpp:3076-3103`); the end tangent is the first control leg (`Geo.cpp:713-740`, only reachable when the point *is* the spline's `start`/`end` object by exact coordinate equality, `Geo.cpp:723`, `732`) | `tangent_at_bspline_knot`, `internal_alignment_knot_point`; end tangent via an auxiliary `line` through pole 1 and 2 + `parallel` | composed; at kinks (mult = degree) not meaningful |
| 4 | Equal (length / radius) | `addConstraintEqualLength` :454; `addConstraintEqualRadius` :455 (circle-circle), :458 (circle-arc), :459 (arc-arc) | `equal_length`, `equal_radius_cc`, `equal_radius_ca`, `equal_radius_aa` | direct |
| 5 | Parallel | `addConstraintParallel` :312 | `parallel` | direct |
| 6 | Perpendicular | line-line `addConstraintPerpendicular` :313/:314; line-circle/arc: centre on the line (`Sketch.cpp:2889-2896`) ; arc-line / arc-arc variants :419-:441 | `perpendicular_ll`, `perpendicular_pppp`, `perpendicular_*2*` | direct |
| 7 | Fix / UnFix | no constraint object: the parameters are simply removed from the unknown list (FreeCAD "Block"); nameable alternative: `addConstraintCoordinateX/Y` :400/:401 (2 constraints) | point `fixed: true`, or `coordinate_x` + `coordinate_y` | direct (2 constraints when it must be named); UnFix = rebuild |
| 8a | Midpoint of a line | `addConstraintP2PSymmetric(p1,p2,Point&)` :462 = on the perpendicular bisector + on the line (`GCS.cpp:1236-1240`); `addConstraintMidpointOnLine` :368/:369 means something else (midpoint of line 1 lies on line 2) | `p2p_symmetric_ppp` (not `midpoint_on_line_*`) | direct |
| 8b | Midpoint of an arc | point on the arc circle :418 + `addConstraintPointOnPerpBisector` :304/:305 on the chord start-end | `point_on_arc` + `point_on_perp_bisector_ppp` | composed (picks the near one of two points on the bisector) |
| 9 | Concentric | no own constraint: the centres coincide (:395) | `p2p_coincident` on the two centre points | composed (1 constraint on helper points) |
| 10 | Collinear | no own constraint: two point-on-line constraints for the second line's end points (FreeCAD does this, `Sketch.cpp:2925-2926`) | 2x `point_on_line_pl` | composed |
| 11 | Symmetry about a line | `addConstraintP2PSymmetric(p1,p2,Line&)` :461 = perpendicular + midpoint on line (`GCS.cpp:1230-1234`); about a point :462 | `p2p_symmetric_ppl`, `p2p_symmetric_ppp` | direct |
| 12 | Curvature (G2) | **none.** No match for "curvature" in `planegcs/`, `Sketch.cpp`, `Constraint.h` (searched with grep). Closest: `ConstraintSlopeAtBSplineKnot` (G1 only, Constraints.cpp:262) | none | **missing** |

### Curvature (G2): what exists and what to do

Facts: planegcs has G1 tools only (`AngleViaPoint` family :332-:358 and `SlopeAtBSplineKnot`). A
signed-curvature equality is a ratio of products of coordinates; the generic constraints
(`Equal`, `Proportional`, `Difference`, `WeightedLinearCombination`) are linear in their parameters
and cannot express it. Proposals (opinion, untested except where marked):

1. **Arc - arc (and arc - circle)**: composed `coincident + tangent (angle via point) + equal radius`.
   Two curves with a common tangent and equal signed curvature lie on the same circle, so for arcs G2
   forces the two arcs onto one circle (case K12a). The solver may pick the other tangency side
   (S-shape, curvatures of opposite sign); the checker compares **signed curvature vectors** and
   rejects that. Probe run against the prebuilt package: this composition solved K12a with all three
   algorithms.
2. **Line - arc**: G2 is only possible with infinite radius, i.e. impossible. The UI must refuse it.
3. **Anything with a B-spline or two splines**: needs a new constraint class
   `EqualCurvatureAtEnd(a, pa, b, pb)`: residual `|kappa_a - kappa_b|` (or the signed-curvature
   difference with a common normal) at the end poles; for a clamped end the curvature depends only on
   the first three poles, the weights and the first knot span, so the residual and its gradient are
   closed-form (and forward-mode differentiation is a fallback). It can be written as a subclass of
   `GCS::Constraint` in our own code (public `addConstraint(Constraint*)` :266; protected members are
   reachable from a subclass) without touching the planegcs sources: possible in the native and in
   our own Emscripten build, **impossible in the prebuilt WASM** (fixed binding list). Not tested.
4. Alternative without new C++: an auxiliary "osculating circle" per junction (circle through the
   junction point with the common tangent) cannot be expressed either, because the curvature of a
   spline end is not a parameter. Not recommended.

## 3. Dimensions

| Fusion dimension | Native | Salusoft | Notes |
|---|---|---|---|
| point-point distance | `addConstraintP2PDistance` :291 | `p2p_distance` | |
| line length | same, on the end points | `p2p_distance` | |
| point-line distance | `addConstraintP2LDistance` :301 | `p2l_distance` | **unsigned** (`abs`, `Constraints.cpp:857-866`): cannot flip the side |
| horizontal / vertical distance | `addConstraintDifference` :284 on the x or y parameters; error = `p2 - p1 - d` (`Constraints.cpp:641-644`), signed | `difference` with `{o_id, prop:'x'|'y'}` refs | |
| angle between lines | `addConstraintL2LAngle` :322/:323; angle of line 2 relative to line 1, wrapped by `atan2` (`Constraints.cpp:1293-1303`) | `l2l_angle_ll` / `_pppp` | |
| angle of a line to the x axis | `addConstraintP2PAngle` :292/:300 | `p2p_angle` | |
| radius | `addConstraintCircleRadius` :450, `addConstraintArcRadius` :451 = equality with a value parameter (`GCS.cpp:1159-1167`) | `circle_radius`, `arc_radius` | |
| diameter | :452/:453 = proportional 0.5 (`GCS.cpp:1169-1177`) | `circle_diameter`, `arc_diameter` | package README lists it as faulty when non-driving |
| arc length | `addConstraintArcLength` :479 | `arc_length` | package README lists it as faulty when non-driving |
| driving / non-driving | `driving` argument of every `addConstraint*`; the value parameter must be unknown + declared driven (:582/:583) | `driving: false` | see section 1 for the wrapper's behaviour |

## 4. Neutral constraint vocabulary (solver-neutral)

Elements (`cases.json` -> `elements[]`): `point {x,y,fixed?}`, `line {p1,p2}`, `circle {center,radius}`,
`arc {center,start,end,radius}` (counter-clockwise from start to end; start/end angles are derived
from the points by the runner and tied to the circle with the arc rules), `bspline {poles[],weights[],
knots[],mult[],degree,periodic}` (distinct knots + multiplicities, planegcs/OCCT convention; for
periodic splines the number of poles is the sum of the multiplicities without the last knot).
Ellipses are not part of the catalogue (not cheap enough, not among the 12 types).

Constraints (`constraints[]`, fields flat next to `id` and `type`; `driving:false` = reference
dimension; `enabled:false` = initially switched off, only used by cases with steps). "Eq" = number of
independent equations (used for the expected DOF).

| type | refs | value | meaning (what the checker evaluates) | Eq |
|---|---|---|---|---|
| `horizontal` / `vertical` | `line` or `p1,p2` | | `y1 = y2` / `x1 = x2` | 1 |
| `coincident` | `p1,p2` | | same place | 2 |
| `point_on_curve` | `point, curve` (+`u0` for splines) | | on the infinite line / on the circle (arc: full circle) / on the spline (min. distance) | 1 |
| `tangent` | `a,b` (line/circle/arc) | | line-circle: centre distance = r; circle-circle: external or internal | 1 |
| `tangent_at` | `a,b,p1,p2` | | `p1 = p2` and tangent directions parallel at that point | 3 |
| `equal` | `a,b` | | lines: equal length; circles/arcs: equal radius | 1 |
| `parallel`, `perpendicular` | `l1,l2` | | undirected line angle | 1 |
| `fix` | `point` | `x,y` | point at the given coordinates (2 coordinate constraints) | 2 |
| `midpoint` | `point, line` or `point, arc` | | line: mean of the end points; arc: on the circle, equidistant from start and end, within the angular span | 2 |
| `concentric` | `a,b` | | same centre | 2 |
| `collinear` | `l1,l2` | | both end points of `l2` on `l1` | 2 |
| `symmetric` | `p1,p2,line` or `p1,p2,center` | | mirrored about the line / about the point | 2 |
| `curvature` | `a,b,p1,p2` | | G2: `p1 = p2`, parallel tangents, equal curvature **vector** (points to the centre, length 1/r) | 4 |
| `tangent_at_knot` | `line, bspline, knot` | | spline point at the knot lies on the line and the slope is parallel (both one-sided slopes for kinks) | 2 |
| `distance` | `p1,p2` | mm | Euclidean | 1 |
| `distance_point_line` | `point,line` | mm | to the infinite line, unsigned | 1 |
| `distance_x` / `distance_y` | `p1,p2` | mm | `x2 - x1` / `y2 - y1`, signed | 1 |
| `length` | `line` | mm | `|p2 - p1|` | 1 |
| `angle` | `l1,l2` | rad | direction angle of `l2` minus that of `l1`, compared modulo 2*pi | 1 |
| `angle_line` | `line` | rad | direction angle of `p1 -> p2`, modulo 2*pi | 1 |
| `radius`, `diameter` | `curve` | mm | circle or arc | 1 |
| `arc_length` | `arc` | mm | `r * ccw sweep` | 1 |

Extra, only used inside `expect.checks` / `step_checks`: `no_cusp` (the two curves leave the junction in
opposite directions: smooth join), `holds` wraps any of the above ad hoc.

## 5. Case format

```
cases.json: { format, units, tolerances:{length,angle,curvature}, cases:[ case | {id,file} ] }
case: {
  id, group, title, notes?,
  elements[], constraints[],
  run_algorithms?: ["DogLeg","LevenbergMarquardt","BFGS"],   // one result entry per algorithm
  steps?: [ { id, label, set?:{constraintId: value | {value,x,y}}, enable?:[ids], disable?:[ids],
              drag?:{point,x,y}, expect?:{...} } ],
  step_checks?: [ {kind:"orientation",points,sign} | {kind:"max_jump",points,max} ],
  tol?: {length,angle,curvature},                              // overrides the global tolerances
  expect: {
    solved: true|false,           // false = the system has no solution: status must not be Success
    status_ok?: ["Success"],      // default; redundancy cases also allow "Converged"
    dof: n | null,                // null = not checked
    conflicting|redundant|partially_redundant: [ids] (exact) | {mode:"empty"} (default) |
        {mode:"exact",ids} | {mode:"within",ids,min?,count?} | {mode:"any"},
    driven?: {constraintId: expected value of a non-driving dimension},
    checks?: [ {kind:"unchanged",ids} | {kind:"point_at",point,x,y} | {kind:"holds",constraint:{...}} |
               {kind:"orientation",points,sign} | {kind:"on_arc_span",point,arc} | {kind:"closed_curve",bspline} ],
    soft?: ["conflicting",...]    // a mismatch in these only gives a warning (known theoretical limit)
  }
}
```

`expect.dof` is derived in `build-cases.mjs` as: free parameters (2 per non-fixed point, +1 per
circle, +3 per arc) minus independent equations (table in section 4, +4 per arc for the arc rules) plus
the rank defect of redundant cases; it counts only the parameters defined in the case file (the
wrapper's spline helper points and a B-spline curve parameter are not counted).

**Steps.** Step 0 is the initial solve; step `k` applies the `set`/`enable`/`disable` of steps 1..k
cumulatively and then solves, starting from the geometry of step `k-1`. A `drag` is temporary (only
for that solve): implement it with temporary coordinate constraints (planegcs tag `-1` /
`temporary:true`), remove them afterwards, keep the resulting geometry. Per-step `expect`: `dof`,
`solved`, the three id sets, `points: {id: [x,y]}` with `tol`, `checks`. Without an explicit per-step
`dof` the case-level `expect.dof` (or `expect.step0.dof` for step 0) applies.

## 6. Result entries the checker expects (extension of the common format)

As in the task's common format, plus: `steps[]` entries carry `step`, `geometry` and optionally `status`,
`dof`, the three id lists, `driven_values`, `time_ms`; the case-level fields describe the **last** step.
`geometry` must contain every point as `{x,y}`, every circle/arc as `{radius}` (lines and splines are
derived from their points). Entries for a case with `run_algorithms` need one entry per algorithm
(`algorithm` = `DogLeg` | `LevenbergMarquardt` | `BFGS`); `supported:"no"` entries are shown as SKIP.
Constraint ids in the id lists are the **case's** constraint ids (the runner maps composed solver
constraints back; a case constraint is `redundant` when all its solver constraints are, otherwise
`partially_redundant`).

## 7. Case list

<!-- CASE-LIST-BEGIN -->
| Id | Group | Elements | Constraints | Steps | DOF | Algorithms | What it tests |
|---|---|---:|---:|---:|---|---|---|
| K01a-horizontal-line | K01 | 3 | 1 | - | 3 | DL | Horizontal constraint on a line |
| K01b-vertical-line | K01 | 3 | 1 | - | 3 | DL | Vertical constraint on a line |
| K01c-horizontal-two-points | K01 | 2 | 1 | - | 3 | DL | Horizontal constraint between two points (no line) |
| K01d-vertical-two-points | K01 | 2 | 1 | - | 3 | DL | Vertical constraint between two points (no line) |
| K02a-coincident-points | K02 | 2 | 1 | - | 2 | DL | Two points coincident |
| K02b-point-on-line | K02 | 4 | 1 | - | 1 | DL | Point on a (fixed) line |
| K02c-point-on-circle | K02 | 3 | 2 | - | 1 | DL | Point on a circle (centre fixed, radius dimension 10) |
| K02d-point-on-arc | K02 | 5 | 2 | - | 3 | DL | Point on the circle of an arc (centre fixed, radius dimension 10) |
| K02e-point-on-bspline | K02 | 6 | 1 | - | 1 | DL | Point on an open cubic B-spline (poles fixed) |
| K03a-tangent-line-circle | K03 | 5 | 2 | - | 1 | DL, LM, BFGS | Line tangent to a circle (centre fixed, radius 5, line start fixed) |
| K03b-tangent-line-arc | K03 | 7 | 2 | - | 3 | DL | Line tangent to the circle of an arc (centre fixed, radius 5) |
| K03c-tangent-circle-circle-external | K03 | 4 | 3 | - | 1 | DL, LM, BFGS | Two circles tangent from outside (radii 5 and 3) |
| K03d-tangent-circle-circle-internal | K03 | 4 | 3 | - | 1 | DL | Small circle tangent inside a big circle (radii 10 and 3) |
| K03e-tangent-arc-arc-endpoint | K03 | 8 | 3 | - | 3 | DL, LM, BFGS | Two counter-clockwise arcs meeting tangentially at an end point (radii 5 and 3, the small one curls inside the big one) |
| K03f-tangent-line-arc-endpoint | K03 | 7 | 2 | - | 3 | DL | Line ending tangentially on an arc (radius 5) |
| K04a-equal-length | K04 | 6 | 1 | - | 3 | DL | Two lines of equal length |
| K04b-equal-radius-circles | K04 | 4 | 2 | - | 0 | DL | Two circles of equal radius (first has radius dimension 5) |
| K04c-equal-radius-circle-arc | K04 | 6 | 2 | - | 2 | DL | Circle and arc of equal radius (circle has radius dimension 4) |
| K04d-equal-radius-arcs | K04 | 8 | 2 | - | 4 | DL | Two arcs of equal radius (first has radius dimension 5) |
| K05a-parallel-one-free | K05 | 6 | 1 | - | 1 | DL | Two lines parallel (first line fixed) |
| K05b-parallel-both-free | K05 | 6 | 1 | - | 7 | DL | Two free lines parallel |
| K06a-perpendicular-one-free | K06 | 6 | 1 | - | 1 | DL | Two lines perpendicular (first line fixed) |
| K06b-perpendicular-both-free | K06 | 6 | 1 | - | 7 | DL | Two free lines perpendicular |
| K07a-fix-point | K07 | 1 | 1 | - | 0 | DL | Fix a point at given coordinates |
| K07b-fix-unfix-sequence | K07 | 3 | 1 | 2 | 2 | DL | Fix, unfix, fix again at another place |
| K07c-fix-line | K07 | 3 | 2 | - | 0 | DL | Fix both end points of a line |
| K08a-midpoint-of-fixed-line | K08 | 4 | 1 | - | 0 | DL | Point at the midpoint of a fixed line |
| K08b-midpoint-fixes-line-end | K08 | 4 | 1 | - | 0 | DL | Line end follows the midpoint: P1 and M fixed, so P2 = 2M - P1 |
| K08c-midpoint-of-arc | K08 | 5 | 2 | - | 2 | DL | Point at the middle of an arc (composed: on the circle and on the bisector of the chord) |
| K09a-concentric-circle-arc | K09 | 6 | 2 | - | 3 | DL | Arc concentric with a circle (circle radius 5) |
| K09b-concentric-circles | K09 | 4 | 3 | - | 0 | DL | Two circles concentric (radii 5 and 8) |
| K10a-collinear-lines | K10 | 6 | 1 | - | 2 | DL | Second line collinear with a fixed first line |
| K11a-symmetric-points-about-line | K11 | 5 | 1 | - | 2 | DL, LM, BFGS | Two points symmetric about a fixed vertical axis |
| K11b-symmetric-points-about-point | K11 | 3 | 1 | - | 0 | DL | Two points symmetric about a fixed centre point |
| K11c-symmetric-about-diagonal | K11 | 5 | 1 | - | 0 | DL | Point mirrored about the fixed diagonal y = x |
| K12a-curvature-arc-arc | K12 | 8 | 2 | - | 3 | DL, LM, BFGS | G2 join of two arcs (composed: coincident + tangent + equal radius) |
| K12b-curvature-arc-bspline | K12 | 9 | 2 | - | per step / n.a. | DL | G2 join of an arc and an open cubic B-spline at the spline start |
| D01-distance-point-point | D | 2 | 1 | - | 1 | DL | Distance between two points = 10 |
| D02-distance-point-line | D | 4 | 1 | - | 1 | DL | Distance of a point from a fixed line = 4 |
| D03-distance-horizontal | D | 2 | 1 | - | 1 | DL | Horizontal distance P1 -> P2 = 12 |
| D04-distance-vertical-negative | D | 2 | 1 | - | 1 | DL | Vertical distance P1 -> P2 = -7 (P2 below P1, signed convention y2 - y1) |
| D05-line-length | D | 3 | 1 | - | 1 | DL, LM, BFGS | Length of a line = 10 |
| D06-angle-between-lines | D | 5 | 1 | - | 1 | DL, LM, BFGS | Angle from L1 (fixed, horizontal) to L2 = 30 degrees |
| D06b-angle-of-line | D | 3 | 1 | - | 1 | DL | Direction angle of a line (to the x axis) = 120 degrees |
| D07a-radius-circle | D | 2 | 1 | - | 0 | DL | Radius of a circle = 7 |
| D07b-radius-arc | D | 4 | 1 | - | 2 | DL | Radius of an arc = 6 |
| D08a-diameter-circle | D | 2 | 1 | - | 0 | DL | Diameter of a circle = 14 |
| D08b-diameter-arc | D | 4 | 1 | - | 2 | DL | Diameter of an arc = 12 |
| D09-arc-length | D | 4 | 2 | - | 1 | DL | Arc of radius 5 with length 5*pi/2 (quarter circle) |
| N01-nondriving-distance | N | 2 | 3 | - | 0 | DL | Reference distance P1-P2 (geometry set by driving distance_x/y = 6/8) |
| N02-nondriving-point-line-distance | N | 4 | 3 | - | 0 | DL | Reference distance of a point from a line |
| N03-nondriving-horizontal-distance | N | 3 | 3 | - | 0 | DL | Reference horizontal distance |
| N04-nondriving-vertical-distance | N | 3 | 3 | - | 0 | DL | Reference vertical distance |
| N05-nondriving-length | N | 3 | 3 | - | 0 | DL | Reference line length |
| N06-nondriving-angle | N | 5 | 3 | - | 0 | DL | Reference angle between two lines |
| N07-nondriving-radius-circle | N | 3 | 2 | - | 0 | DL | Reference radius of a circle through a fixed point |
| N08-nondriving-diameter-circle | N | 3 | 2 | - | 0 | DL | Reference diameter of a circle through a fixed point (README of the package lists this type as faulty) |
| N09-nondriving-arc-length | N | 4 | 2 | - | 0 | DL | Reference arc length (README of the package lists this type as faulty) |
| N10-nondriving-radius-arc | N | 4 | 2 | - | 0 | DL | Reference radius of an arc |
| N11-nondriving-on-free-line | N | 3 | 1 | - | 4 | DL | Reference length on a free line: nothing moves, DOF stays 4 |
| T01-free-line | T | 3 | 0 | - | 4 | DL | A free line has 4 degrees of freedom |
| T02-rectangle-to-zero-dof | T | 8 | 9 | 7 | per step / n.a. | DL | Rectangle constrained step by step to 0 DOF, then a redundant and a contradicting dimension |
| C01-contradicting-lengths | C | 3 | 2 | - | per step / n.a. | DL | Two length dimensions of one line (10 and 20) (no solution expected) |
| C02a-horizontal-vertical-length | C | 3 | 3 | - | per step / n.a. | DL | Horizontal + vertical + length 10 on one line (contradiction) (no solution expected) |
| C02b-horizontal-vertical-degenerate | C | 3 | 2 | - | 2 | DL | Horizontal + vertical on one free line (no contradiction, the line collapses to a point) |
| C03-contradicting-triangle | C | 6 | 3 | - | per step / n.a. | DL | Triangle with sides 3, 4 and 10 (violates the triangle inequality) (no solution expected) |
| C04-redundant-parallel | C | 6 | 3 | - | 6 | DL | Both lines horizontal AND parallel: one of the three constraints is redundant (consistent) |
| C05-duplicate-dimension | C | 2 | 2 | - | 1 | DL | The same horizontal distance dimensioned twice (consistent duplicate) |
| C06-partially-redundant | C | 7 | 2 | - | 1 | DL | Symmetry (2 equations) plus midpoint (2 equations) share one equation: partially redundant |
| B01-spline-end-on-line | B | 8 | 1 | - | 6 | DL | Open cubic Bezier: its first pole coincident with the end of a line |
| B02-spline-tangent-to-line-at-end | B | 8 | 1 | - | 5 | DL | Open cubic Bezier: line ends tangentially at the spline start (G1) |
| B03a-periodic-spline-dimension | B | 7 | 1 | - | 9 | DL | Periodic (closed) cubic B-spline, 6 poles; distance between pole 1 and pole 4 = 12 |
| B03b-periodic-spline-point-on-curve | B | 8 | 1 | - | 1 | DL | Point on a periodic cubic B-spline (poles fixed) |
| B04-quadratic-spline-tangent-at-interior-knot | B | 9 | 1 | - | 6 | DL | Degree 2 spline with interior knots: a line touches it tangentially at knot index 2 |
| B05-cubic-spline-tangent-at-c1-knot | B | 10 | 1 | - | 8 | DL | Cubic spline, interior knot multiplicity 2 (C1): a line touches it tangentially at that knot |
| B06-knot-multiplicity-equals-degree | B | 11 | 1 | - | 10 | DL | Cubic spline with an interior knot of multiplicity 3 (C0 kink at pole 4): a line tangent at the kink |
| B07-rational-quarter-circle | B | 6 | 1 | - | 1 | DL | Rational quadratic B-spline = exact quarter circle of radius 5; a free point on it must end up at distance 5 from the origin |
| S01-triangle-side-sweep | S | 6 | 4 | 9 | 0 | DL | Isosceles triangle, one side stepped 10 -> 100 in 10 steps, each solve starts from the previous result |
| S02-line-angle-sweep | S | 3 | 2 | 23 | 0 | DL | Line of length 40 rotated in 15 degree steps from 10 to 355 degrees (passes +-pi) |
| S03-circle-tangent-radius-sweep | S | 6 | 3 | 9 | 0 | DL | Circle tangent to a line, radius stepped 10 -> 50 (centre x fixed at 0); it must stay on the same side of the line |
| S04-drag-fixed-length-line | S | 3 | 1 | 12 | 1 | DL | Drag the free end of a line of fixed length 10 around, mouse always at distance 14 (end must follow along the circle of radius 10) |
| S05-drag-chain-reachable | S | 21 | 10 | 30 | 10 | DL | Chain of 10 links (length 5), origin fixed; the tip is dragged in small steps along an outward spiral inside the reach: it must reach the mouse position |
| P01-grid-50 | P | 48 | 42 | - | 0 | DL | Connected chain of 6 fully dimensioned rectangles (48 elements) |
| P02-grid-200 | P | 200 | 175 | - | 0 | DL | Connected 5x5 grid of fully dimensioned rectangles (200 elements) |
| P03-grid-1000 | P | 1000 | 875 | - | 0 | DL | Connected 5x25 grid of fully dimensioned rectangles (1000 elements) |
| P04-drag-chain-100-steps | P | 81 | 40 | 100 | 40 | DL | Chain of 40 links (length 5), origin fixed; 100 drag steps of the tip along an outward spiral (timing of a drag sequence) |

86 cases, 100 result entries (cases with several algorithms count once per algorithm).
<!-- CASE-LIST-END -->

## 8. Expectations that are known to be theoretical limits

- C03 (contradicting triangle) has no structural dependency at the start; the diagnosis is rank based,
  so the conflict may not be nameable: the `conflicting` check is soft (`expect.soft`).
- C06 (partially redundant): which constraint of a dependent group is reported depends on the heuristic
  (`GCS.cpp:5492-5510`): the redundant / partially-redundant checks are soft.
- Redundant cases may come back as `Converged` instead of `Success` (rank-deficient Jacobian); the
  geometry must still satisfy every constraint.
- B06 (kink): FreeCAD refuses the constraint; a track may answer `supported:"no"`.
- K12b (curvature arc-spline): needs a new constraint class; expect `supported:"no"` for the prebuilt
  package.
