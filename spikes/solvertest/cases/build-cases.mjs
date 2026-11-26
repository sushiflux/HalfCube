#!/usr/bin/env node
// Generates the solver-neutral case catalogue (cases.json + large-*.json) deterministically.
// The generated files are the input of all tracks; this script is only the source they are written
// from (so ids and numbers stay stable and reviewable). Run: node cases/build-cases.mjs
//
// Conventions (see ../CASES.md): millimetres and radians, right-handed, y up. Arcs run counter-
// clockwise from `start` to `end`. Every case starts from a deliberately OFF position so the solver
// has work to do. `expect.dof` is derived here from the parameter and equation counts below; cases
// with dependent equations add a `defect`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ctx, bsplineClosest } from '../check/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PI = Math.PI;
const deg = (d) => (d * PI) / 180;

// equations contributed by one DRIVING constraint of each neutral type (independent case)
const EQ = {
  horizontal: 1, vertical: 1, coincident: 2, point_on_curve: 1, tangent: 1, tangent_at: 3, equal: 1,
  parallel: 1, perpendicular: 1, fix: 2, midpoint: 2, concentric: 2, collinear: 2, symmetric: 2,
  curvature: 4, tangent_at_knot: 2, distance: 1, distance_point_line: 1, distance_x: 1, distance_y: 1,
  length: 1, angle: 1, angle_line: 1, radius: 1, diameter: 1, arc_length: 1,
};

class Case {
  constructor(id, group, title, notes) {
    this.def = { id, group, title, notes: notes || undefined, elements: [], constraints: [], expect: { solved: true } };
    this.n = 0;
    this.defect = 0;
  }
  pt(id, x, y, fixed = false) { this.def.elements.push(fixed ? { id, type: 'point', x, y, fixed: true } : { id, type: 'point', x, y }); return this; }
  line(id, p1, p2) { this.def.elements.push({ id, type: 'line', p1, p2 }); return this; }
  circle(id, center, radius) { this.def.elements.push({ id, type: 'circle', center, radius }); return this; }
  arc(id, center, start, end, radius) { this.def.elements.push({ id, type: 'arc', center, start, end, radius }); return this; }
  bspline(id, poles, weights, knots, mult, degree, periodic = false) {
    this.def.elements.push({ id, type: 'bspline', poles, weights, knots, mult, degree, periodic });
    return this;
  }
  // adds a constraint; returns its id
  con(type, refs, value, opts = {}) {
    const id = `c${++this.n}`;
    const c = { id, type, ...refs };
    if (value !== undefined) c.value = value;
    if (opts.driving === false) c.driving = false;
    if (opts.enabled === false) c.enabled = false;
    this.def.constraints.push(c);
    return id;
  }
  expect(o) { Object.assign(this.def.expect, o); return this; }
  algos(list = ['DogLeg', 'LevenbergMarquardt', 'BFGS']) { this.def.run_algorithms = list; return this; }
  steps(list) { this.def.steps = list; return this; }
  checks(list) { this.def.expect.checks = [...(this.def.expect.checks || []), ...list]; return this; }
  // free parameters minus independent equations of the driving, enabled constraints
  dof(defect = 0) {
    let params = 0, eqs = 0;
    for (const e of this.def.elements) {
      if (e.type === 'point' && !e.fixed) params += 2;
      if (e.type === 'circle') params += 1;
      if (e.type === 'arc') { params += 3; eqs += 4; } // radius + 2 angles, 4 arc rules
    }
    for (const c of this.def.constraints) {
      if (c.driving === false || c.enabled === false) continue;
      eqs += EQ[c.type] ?? 0;
    }
    return params - eqs + defect;
  }
  done(defect = 0) { if (this.def.expect.dof === undefined) this.def.expect.dof = this.dof(defect); return this.def; }
}

const cases = [];
const add = (c) => { cases.push(c); return c; };

// ================================================================================================
// K01 horizontal / vertical
// ================================================================================================

{
  let c = new Case('K01a-horizontal-line', 'K01', 'Horizontal constraint on a line').pt('P1', 0, 0).pt('P2', 10, 3).line('L1', 'P1', 'P2');
  c.con('horizontal', { line: 'L1' }); add(c.done());
  c = new Case('K01b-vertical-line', 'K01', 'Vertical constraint on a line').pt('P1', 0, 0).pt('P2', 3, 10).line('L1', 'P1', 'P2');
  c.con('vertical', { line: 'L1' }); add(c.done());
  c = new Case('K01c-horizontal-two-points', 'K01', 'Horizontal constraint between two points (no line)').pt('P1', 0, 0).pt('P2', 10, 4);
  c.con('horizontal', { p1: 'P1', p2: 'P2' }); add(c.done());
  c = new Case('K01d-vertical-two-points', 'K01', 'Vertical constraint between two points (no line)').pt('P1', 0, 0).pt('P2', 4, 10);
  c.con('vertical', { p1: 'P1', p2: 'P2' }); add(c.done());
}

// ================================================================================================
// K02 coincident (point-point and point-on-curve)
// ================================================================================================
{
  let c = new Case('K02a-coincident-points', 'K02', 'Two points coincident').pt('P1', 0, 0).pt('P2', 5, 4);
  c.con('coincident', { p1: 'P1', p2: 'P2' }); add(c.done());

  c = new Case('K02b-point-on-line', 'K02', 'Point on a (fixed) line').pt('P1', 0, 0, true).pt('P2', 10, 0, true).pt('P3', 4, 3).line('L1', 'P1', 'P2');
  c.con('point_on_curve', { point: 'P3', curve: 'L1' }); add(c.done());

  c = new Case('K02c-point-on-circle', 'K02', 'Point on a circle (centre fixed, radius dimension 10)').pt('O', 0, 0, true).pt('P', 8, 7).circle('C1', 'O', 9);
  c.con('radius', { curve: 'C1' }, 10); c.con('point_on_curve', { point: 'P', curve: 'C1' }); add(c.done());

  c = new Case('K02d-point-on-arc', 'K02', 'Point on the circle of an arc (centre fixed, radius dimension 10)', 'planegcs treats point-on-arc as point-on-circle (GCS.cpp:1009); the angular span is not enforced.')
    .pt('O', 0, 0, true).pt('S', 10, 1).pt('E', 1, 10).pt('P', 6, 9).arc('A1', 'O', 'S', 'E', 10);
  c.con('radius', { curve: 'A1' }, 10); c.con('point_on_curve', { point: 'P', curve: 'A1' }); add(c.done());

  // point on a B-spline: the parameter hint u0 is computed with the checker's own evaluator
  {
    const poles = [['P1', 0, 0], ['P2', 2, 5], ['P3', 6, 5.5], ['P4', 9, 0.3]];
    const spec = { degree: 3, knots: [0, 1], mult: [4, 4], weights: [1, 1, 1, 1], periodic: false };
    const start = [4.2, 3.2];
    const u0 = bsplineClosest(spec, poles.map((p) => [p[1], p[2]]), start).u;
    c = new Case('K02e-point-on-bspline', 'K02', 'Point on an open cubic B-spline (poles fixed)', 'planegcs needs the curve parameter u as an extra unknown (point_on_bspline); u0 is only the starting value for it.');
    for (const p of poles) c.pt(p[0], p[1], p[2], true);
    c.pt('Pt', start[0], start[1]).bspline('B1', poles.map((p) => p[0]), [1, 1, 1, 1], [0, 1], [4, 4], 3, false);
    c.con('point_on_curve', { point: 'Pt', curve: 'B1', u0 }); add(c.done());
  }
}

// ================================================================================================
// K03 tangent
// ================================================================================================
{
  let c = new Case('K03a-tangent-line-circle', 'K03', 'Line tangent to a circle (centre fixed, radius 5, line start fixed)')
    .pt('O', 0, 0, true).pt('P1', -8, 5, true).pt('P2', 8, 6).line('L1', 'P1', 'P2').circle('C1', 'O', 5);
  c.con('radius', { curve: 'C1' }, 5); c.con('tangent', { a: 'L1', b: 'C1' }); add(c.algos().done());

  c = new Case('K03b-tangent-line-arc', 'K03', 'Line tangent to the circle of an arc (centre fixed, radius 5)')
    .pt('O', 0, 0, true).pt('S', 4.8, 1.5).pt('E', 1.2, 4.9).arc('A1', 'O', 'S', 'E', 5).pt('P1', -8, 5, true).pt('P2', 8, 6).line('L1', 'P1', 'P2');
  c.con('radius', { curve: 'A1' }, 5); c.con('tangent', { a: 'L1', b: 'A1' }); add(c.done());

  c = new Case('K03c-tangent-circle-circle-external', 'K03', 'Two circles tangent from outside (radii 5 and 3)', 'planegcs decides external/internal when the constraint is created, from the current centre distance (GCS.cpp:1111).')
    .pt('O1', 0, 0, true).pt('O2', 12, 1).circle('C1', 'O1', 5).circle('C2', 'O2', 3);
  c.con('radius', { curve: 'C1' }, 5); c.con('radius', { curve: 'C2' }, 3); c.con('tangent', { a: 'C1', b: 'C2' }); add(c.algos().done());

  c = new Case('K03d-tangent-circle-circle-internal', 'K03', 'Small circle tangent inside a big circle (radii 10 and 3)')
    .pt('O1', 0, 0, true).pt('O2', 4, 1).circle('C1', 'O1', 10).circle('C2', 'O2', 3);
  c.con('radius', { curve: 'C1' }, 10); c.con('radius', { curve: 'C2' }, 3); c.con('tangent', { a: 'C1', b: 'C2' }); add(c.done());

  c = new Case('K03e-tangent-arc-arc-endpoint', 'K03', 'Two counter-clockwise arcs meeting tangentially at an end point (radii 5 and 3, the small one curls inside the big one)', 'Endpoint tangency = coincident + tangent direction (angle via point). Internal tangency, so both ccw arcs continue without a cusp.')
    .pt('O1', 0, 0, true).pt('S1', 5, 0.2).pt('E1', 3.1, 3.9).arc('A1', 'O1', 'S1', 'E1', 5)
    .pt('O2', 1.4, 1.9).pt('S2', 3.2, 4.1).pt('E2', -1.6, 1.7).arc('A2', 'O2', 'S2', 'E2', 3);
  c.con('radius', { curve: 'A1' }, 5); c.con('radius', { curve: 'A2' }, 3); c.con('tangent_at', { a: 'A1', b: 'A2', p1: 'E1', p2: 'S2' });
  c.checks([{ kind: 'holds', constraint: { type: 'no_cusp', a: 'A1', b: 'A2', p1: 'E1', p2: 'S2' } }]); add(c.algos().done());

  c = new Case('K03f-tangent-line-arc-endpoint', 'K03', 'Line ending tangentially on an arc (radius 5)')
    .pt('P1', 0, 0, true).pt('P2', 10, 0.5).line('L1', 'P1', 'P2')
    .pt('O', 10.4, 5.3).pt('S', 10.2, 0.4).pt('E', 15.5, 5.5).arc('A1', 'O', 'S', 'E', 5);
  c.con('radius', { curve: 'A1' }, 5); c.con('tangent_at', { a: 'L1', b: 'A1', p1: 'P2', p2: 'S' });
  c.checks([{ kind: 'holds', constraint: { type: 'no_cusp', a: 'L1', b: 'A1', p1: 'P2', p2: 'S' } }]); add(c.done());
}

// ================================================================================================
// K04 equal
// ================================================================================================
{
  let c = new Case('K04a-equal-length', 'K04', 'Two lines of equal length').pt('P1', 0, 0, true).pt('P2', 10, 2).pt('P3', 0, 5, true).pt('P4', 6, 8).line('L1', 'P1', 'P2').line('L2', 'P3', 'P4');
  c.con('equal', { a: 'L1', b: 'L2' }); add(c.done());

  c = new Case('K04b-equal-radius-circles', 'K04', 'Two circles of equal radius (first has radius dimension 5)').pt('O1', 0, 0, true).pt('O2', 20, 0, true).circle('C1', 'O1', 4).circle('C2', 'O2', 7);
  c.con('radius', { curve: 'C1' }, 5); c.con('equal', { a: 'C1', b: 'C2' }); add(c.done());

  c = new Case('K04c-equal-radius-circle-arc', 'K04', 'Circle and arc of equal radius (circle has radius dimension 4)').pt('O1', 0, 0, true).circle('C1', 'O1', 3)
    .pt('O2', 20, 0, true).pt('S', 24.1, 0.3).pt('E', 20.2, 4.2).arc('A1', 'O2', 'S', 'E', 4.2);
  c.con('radius', { curve: 'C1' }, 4); c.con('equal', { a: 'C1', b: 'A1' }); add(c.done());

  c = new Case('K04d-equal-radius-arcs', 'K04', 'Two arcs of equal radius (first has radius dimension 5)')
    .pt('O1', 0, 0, true).pt('S1', 5.1, 0.2).pt('E1', 0.2, 5.1).arc('A1', 'O1', 'S1', 'E1', 5)
    .pt('O2', 15, 0, true).pt('S2', 18.5, 0.1).pt('E2', 15.2, 3.4).arc('A2', 'O2', 'S2', 'E2', 3.4);
  c.con('radius', { curve: 'A1' }, 5); c.con('equal', { a: 'A1', b: 'A2' }); add(c.done());
}

// ================================================================================================
// K05 parallel, K06 perpendicular
// ================================================================================================
{
  let c = new Case('K05a-parallel-one-free', 'K05', 'Two lines parallel (first line fixed)').pt('P1', 0, 0, true).pt('P2', 10, 1, true).pt('P3', 0, 5, true).pt('P4', 8, 8).line('L1', 'P1', 'P2').line('L2', 'P3', 'P4');
  c.con('parallel', { l1: 'L1', l2: 'L2' }); add(c.done());
  c = new Case('K05b-parallel-both-free', 'K05', 'Two free lines parallel').pt('P1', 0, 0).pt('P2', 10, 1).pt('P3', 0, 5).pt('P4', 8, 8).line('L1', 'P1', 'P2').line('L2', 'P3', 'P4');
  c.con('parallel', { l1: 'L1', l2: 'L2' }); add(c.done());
  c = new Case('K06a-perpendicular-one-free', 'K06', 'Two lines perpendicular (first line fixed)').pt('P1', 0, 0, true).pt('P2', 10, 0, true).pt('P3', 3, -2, true).pt('P4', 5, 6).line('L1', 'P1', 'P2').line('L2', 'P3', 'P4');
  c.con('perpendicular', { l1: 'L1', l2: 'L2' }); add(c.done());
  c = new Case('K06b-perpendicular-both-free', 'K06', 'Two free lines perpendicular').pt('P1', 0, 0).pt('P2', 10, 2).pt('P3', 3, -2).pt('P4', 5, 6).line('L1', 'P1', 'P2').line('L2', 'P3', 'P4');
  c.con('perpendicular', { l1: 'L1', l2: 'L2' }); add(c.done());
}

// ================================================================================================
// K07 fix / unfix
// ================================================================================================
{
  let c = new Case('K07a-fix-point', 'K07', 'Fix a point at given coordinates').pt('P1', 1, 1);
  c.con('fix', { point: 'P1', x: 3, y: 4 }); add(c.done());

  c = new Case('K07b-fix-unfix-sequence', 'K07', 'Fix, unfix, fix again at another place', 'Unfix = removing the constraint: the point must stay where it is and gain its 2 DOF back.')
    .pt('P1', 1, 1).pt('P2', 6, 2).line('L1', 'P1', 'P2');
  const f = c.con('fix', { point: 'P1', x: 3, y: 4 });
  c.steps([
    { id: 's1', label: 'unfix', disable: [f], expect: { dof: 4, checks: [{ kind: 'point_at', point: 'P1', x: 3, y: 4 }] } },
    { id: 's2', label: 'fix again at (6, 2)', enable: [f], set: { [f]: { x: 6, y: 2 } }, expect: { dof: 2 } },
  ]);
  add(c.expect({ step0: { dof: 2 }, dof: 2 }).done());

  c = new Case('K07c-fix-line', 'K07', 'Fix both end points of a line').pt('P1', 0, 0).pt('P2', 10, 3).line('L1', 'P1', 'P2');
  c.con('fix', { point: 'P1', x: 1, y: 1 }); c.con('fix', { point: 'P2', x: 8, y: 2 }); add(c.done());
}

// ================================================================================================
// K08 midpoint, K09 concentric, K10 collinear, K11 symmetric
// ================================================================================================
{
  let c = new Case('K08a-midpoint-of-fixed-line', 'K08', 'Point at the midpoint of a fixed line').pt('P1', 0, 0, true).pt('P2', 10, 4, true).pt('M', 3, 3).line('L1', 'P1', 'P2');
  c.con('midpoint', { point: 'M', line: 'L1' }); add(c.done());

  c = new Case('K08b-midpoint-fixes-line-end', 'K08', 'Line end follows the midpoint: P1 and M fixed, so P2 = 2M - P1').pt('P1', 0, 0, true).pt('M', 6, 3, true).pt('P2', 10, 4).line('L1', 'P1', 'P2');
  c.con('midpoint', { point: 'M', line: 'L1' }); add(c.done());

  c = new Case('K08c-midpoint-of-arc', 'K08', 'Point at the middle of an arc (composed: on the circle and on the bisector of the chord)', 'Arc midpoint has no planegcs constraint; composition: point-on-arc + point-on-perpendicular-bisector(S,E).')
    .pt('O', 0, 0, true).pt('S', 5, 0.1).pt('E', 0.2, 5).pt('M', 3.2, 3.7).arc('A1', 'O', 'S', 'E', 5);
  c.con('radius', { curve: 'A1' }, 5); c.con('midpoint', { point: 'M', arc: 'A1' }); add(c.done());

  c = new Case('K09a-concentric-circle-arc', 'K09', 'Arc concentric with a circle (circle radius 5)').pt('O1', 0, 0, true).circle('C1', 'O1', 5)
    .pt('Q', 1.5, 1).pt('S', 6, 1).pt('E', 1, 6.2).arc('A1', 'Q', 'S', 'E', 5);
  c.con('radius', { curve: 'C1' }, 5); c.con('concentric', { a: 'C1', b: 'A1' }); add(c.done());

  c = new Case('K09b-concentric-circles', 'K09', 'Two circles concentric (radii 5 and 8)').pt('O1', 0, 0, true).pt('O2', 0.5, -0.7).circle('C1', 'O1', 5).circle('C2', 'O2', 8);
  c.con('radius', { curve: 'C1' }, 5); c.con('radius', { curve: 'C2' }, 8); c.con('concentric', { a: 'C1', b: 'C2' }); add(c.done());

  c = new Case('K10a-collinear-lines', 'K10', 'Second line collinear with a fixed first line').pt('P1', 0, 0, true).pt('P2', 10, 2, true).pt('P3', 12, 4).pt('P4', 20, 3).line('L1', 'P1', 'P2').line('L2', 'P3', 'P4');
  c.con('collinear', { l1: 'L1', l2: 'L2' }); add(c.done());

  c = new Case('K11a-symmetric-points-about-line', 'K11', 'Two points symmetric about a fixed vertical axis').pt('A1', 0, 0, true).pt('A2', 0, 10, true).line('Axis', 'A1', 'A2').pt('P', -3, 2).pt('Q', 4, 3);
  c.con('symmetric', { p1: 'P', p2: 'Q', line: 'Axis' }); add(c.algos().done());

  c = new Case('K11b-symmetric-points-about-point', 'K11', 'Two points symmetric about a fixed centre point').pt('C', 0, 0, true).pt('P', -3, 2, true).pt('Q', 4, 3);
  c.con('symmetric', { p1: 'P', p2: 'Q', center: 'C' }); add(c.done());

  c = new Case('K11c-symmetric-about-diagonal', 'K11', 'Point mirrored about the fixed diagonal y = x').pt('A1', 0, 0, true).pt('A2', 10, 10, true).line('Axis', 'A1', 'A2').pt('P', 1, 4, true).pt('Q', 3.5, 0.5);
  c.con('symmetric', { p1: 'P', p2: 'Q', line: 'Axis' }); add(c.done());
}

// ================================================================================================
// K12 curvature continuity (G2)
// ================================================================================================
{
  let c = new Case('K12a-curvature-arc-arc', 'K12', 'G2 join of two arcs (composed: coincident + tangent + equal radius)', 'Two arcs with equal signed curvature and a common tangent at the joint lie on the same circle: expect centre of A2 = centre of A1 and radius 5.')
    .pt('O1', 0, 0, true).pt('S1', 5, 0.2).pt('E1', 3, 4).arc('A1', 'O1', 'S1', 'E1', 5)
    .pt('O2', 0.4, 0.3).pt('S2', 3.1, 3.9).pt('E2', -4, 3).arc('A2', 'O2', 'S2', 'E2', 4.9);
  c.con('radius', { curve: 'A1' }, 5); c.con('curvature', { a: 'A1', b: 'A2', p1: 'E1', p2: 'S2' });
  c.checks([{ kind: 'holds', constraint: { type: 'concentric', a: 'A1', b: 'A2' } }, { kind: 'holds', constraint: { type: 'equal', a: 'A1', b: 'A2' } }]);
  add(c.algos().done());

  c = new Case('K12b-curvature-arc-bspline', 'K12', 'G2 join of an arc and an open cubic B-spline at the spline start', 'planegcs has no curvature constraint (no match for "urvature" in planegcs/ and Sketch.cpp). Needs a new constraint class, impossible in the prebuilt WASM.')
    .pt('O', 0, 0, true).pt('S', 5, 0.2).pt('E', 3, 4).arc('A1', 'O', 'S', 'E', 5)
    .pt('P1', 3.1, 3.9).pt('P2', 2.0, 5.6).pt('P3', -1, 7).pt('P4', -5, 6)
    .bspline('B1', ['P1', 'P2', 'P3', 'P4'], [1, 1, 1, 1], [0, 1], [4, 4], 3, false);
  c.con('radius', { curve: 'A1' }, 5); c.con('curvature', { a: 'A1', b: 'B1', p1: 'E', p2: 'P1' });
  c.checks([{ kind: 'holds', constraint: { type: 'no_cusp', a: 'A1', b: 'B1', p1: 'E', p2: 'P1' } }]);
  add(c.expect({ dof: null }).done());
}

// ================================================================================================
// D dimensions
// ================================================================================================
{
  let c = new Case('D01-distance-point-point', 'D', 'Distance between two points = 10').pt('P1', 0, 0, true).pt('P2', 8, 5);
  c.con('distance', { p1: 'P1', p2: 'P2' }, 10); add(c.done());
  c = new Case('D02-distance-point-line', 'D', 'Distance of a point from a fixed line = 4').pt('A', 0, 0, true).pt('B', 10, 0, true).line('L1', 'A', 'B').pt('P', 3, 2);
  c.con('distance_point_line', { point: 'P', line: 'L1' }, 4); add(c.done());
  c = new Case('D03-distance-horizontal', 'D', 'Horizontal distance P1 -> P2 = 12').pt('P1', 0, 0, true).pt('P2', 8, 5);
  c.con('distance_x', { p1: 'P1', p2: 'P2' }, 12); add(c.done());
  c = new Case('D04-distance-vertical-negative', 'D', 'Vertical distance P1 -> P2 = -7 (P2 below P1, signed convention y2 - y1)').pt('P1', 0, 0, true).pt('P2', 8, 5);
  c.con('distance_y', { p1: 'P1', p2: 'P2' }, -7); add(c.done());
  c = new Case('D05-line-length', 'D', 'Length of a line = 10').pt('P1', 0, 0, true).pt('P2', 8, 5).line('L1', 'P1', 'P2');
  c.con('length', { line: 'L1' }, 10); add(c.algos().done());
  c = new Case('D06-angle-between-lines', 'D', 'Angle from L1 (fixed, horizontal) to L2 = 30 degrees').pt('A', 0, 0, true).pt('B', 10, 0, true).pt('D', 8, 2).line('L1', 'A', 'B').line('L2', 'A', 'D');
  c.con('angle', { l1: 'L1', l2: 'L2' }, deg(30)); add(c.algos().done());
  c = new Case('D06b-angle-of-line', 'D', 'Direction angle of a line (to the x axis) = 120 degrees').pt('P1', 0, 0, true).pt('P2', 5, 4).line('L1', 'P1', 'P2');
  c.con('angle_line', { line: 'L1' }, deg(120)); add(c.done());
  c = new Case('D07a-radius-circle', 'D', 'Radius of a circle = 7').pt('O', 0, 0, true).circle('C1', 'O', 5);
  c.con('radius', { curve: 'C1' }, 7); add(c.done());
  c = new Case('D07b-radius-arc', 'D', 'Radius of an arc = 6').pt('O', 0, 0, true).pt('S', 5.2, 0.4).pt('E', 0.3, 5.1).arc('A1', 'O', 'S', 'E', 5);
  c.con('radius', { curve: 'A1' }, 6); add(c.done());
  c = new Case('D08a-diameter-circle', 'D', 'Diameter of a circle = 14').pt('O', 0, 0, true).circle('C1', 'O', 5);
  c.con('diameter', { curve: 'C1' }, 14); add(c.done());
  c = new Case('D08b-diameter-arc', 'D', 'Diameter of an arc = 12').pt('O', 0, 0, true).pt('S', 5.2, 0.4).pt('E', 0.3, 5.1).arc('A1', 'O', 'S', 'E', 5);
  c.con('diameter', { curve: 'A1' }, 12); add(c.done());
  c = new Case('D09-arc-length', 'D', 'Arc of radius 5 with length 5*pi/2 (quarter circle)').pt('O', 0, 0, true).pt('S', 5, 0.2).pt('E', 0.3, 5).arc('A1', 'O', 'S', 'E', 5);
  c.con('radius', { curve: 'A1' }, 5); c.con('arc_length', { arc: 'A1' }, (5 * PI) / 2); add(c.done());
}

// ================================================================================================
// N non-driving (reference) dimensions. The initial value is deliberately wrong: it is only an
// output (driven_values) and must not influence the geometry.
// ================================================================================================
{
  let c = new Case('N01-nondriving-distance', 'N', 'Reference distance P1-P2 (geometry set by driving distance_x/y = 6/8)').pt('P1', 0, 0, true).pt('P2', 6.2, 7.7);
  c.con('distance_x', { p1: 'P1', p2: 'P2' }, 6); c.con('distance_y', { p1: 'P1', p2: 'P2' }, 8);
  const n1 = c.con('distance', { p1: 'P1', p2: 'P2' }, 9, { driving: false });
  add(c.expect({ driven: { [n1]: 10 } }).done());

  c = new Case('N02-nondriving-point-line-distance', 'N', 'Reference distance of a point from a line').pt('A', 0, 0, true).pt('B', 10, 0, true).line('L1', 'A', 'B').pt('P', 3.1, 3.7);
  c.con('distance_x', { p1: 'A', p2: 'P' }, 3); c.con('distance_y', { p1: 'A', p2: 'P' }, 4);
  const n2 = c.con('distance_point_line', { point: 'P', line: 'L1' }, 3, { driving: false });
  add(c.expect({ driven: { [n2]: 4 } }).done());

  c = new Case('N03-nondriving-horizontal-distance', 'N', 'Reference horizontal distance').pt('P1', 0, 0, true).pt('P2', 4.5, 5.1).line('L1', 'P1', 'P2');
  c.con('length', { line: 'L1' }, 5); c.con('angle_line', { line: 'L1' }, Math.atan2(4, 3));
  const n3 = c.con('distance_x', { p1: 'P1', p2: 'P2' }, 1, { driving: false });
  add(c.expect({ driven: { [n3]: 3 } }).done());

  c = new Case('N04-nondriving-vertical-distance', 'N', 'Reference vertical distance').pt('P1', 0, 0, true).pt('P2', 4.5, 5.1).line('L1', 'P1', 'P2');
  c.con('length', { line: 'L1' }, 5); c.con('angle_line', { line: 'L1' }, Math.atan2(4, 3));
  const n4 = c.con('distance_y', { p1: 'P1', p2: 'P2' }, 1, { driving: false });
  add(c.expect({ driven: { [n4]: 4 } }).done());

  c = new Case('N05-nondriving-length', 'N', 'Reference line length').pt('P1', 0, 0, true).pt('P2', 3.3, 3.6).line('L1', 'P1', 'P2');
  c.con('distance_x', { p1: 'P1', p2: 'P2' }, 3); c.con('distance_y', { p1: 'P1', p2: 'P2' }, 4);
  const n5 = c.con('length', { line: 'L1' }, 2, { driving: false });
  add(c.expect({ driven: { [n5]: 5 } }).done());

  c = new Case('N06-nondriving-angle', 'N', 'Reference angle between two lines').pt('A', 0, 0, true).pt('B', 10, 0, true).pt('D', 6.3, 3.1).line('L1', 'A', 'B').line('L2', 'A', 'D');
  c.con('distance_x', { p1: 'A', p2: 'D' }, 6); c.con('distance_y', { p1: 'A', p2: 'D' }, 6 * Math.tan(PI / 6));
  const n6 = c.con('angle', { l1: 'L1', l2: 'L2' }, 1, { driving: false });
  add(c.expect({ driven: { [n6]: PI / 6 } }).done());

  c = new Case('N07-nondriving-radius-circle', 'N', 'Reference radius of a circle through a fixed point').pt('O', 0, 0, true).pt('P', 3, 4, true).circle('C1', 'O', 4);
  c.con('point_on_curve', { point: 'P', curve: 'C1' });
  const n7 = c.con('radius', { curve: 'C1' }, 4, { driving: false });
  add(c.expect({ driven: { [n7]: 5 } }).done());

  c = new Case('N08-nondriving-diameter-circle', 'N', 'Reference diameter of a circle through a fixed point (README of the package lists this type as faulty)').pt('O', 0, 0, true).pt('P', 3, 4, true).circle('C1', 'O', 4);
  c.con('point_on_curve', { point: 'P', curve: 'C1' });
  const n8 = c.con('diameter', { curve: 'C1' }, 8, { driving: false });
  add(c.expect({ driven: { [n8]: 10 } }).done());

  c = new Case('N09-nondriving-arc-length', 'N', 'Reference arc length (README of the package lists this type as faulty)').pt('O', 0, 0, true).pt('S', 5, 0, true).pt('E', 0.3, 4.8).arc('A1', 'O', 'S', 'E', 5);
  c.con('distance_x', { p1: 'O', p2: 'E' }, 0);
  const n9 = c.con('arc_length', { arc: 'A1' }, 6, { driving: false });
  add(c.expect({ driven: { [n9]: (5 * PI) / 2 } }).done());

  c = new Case('N10-nondriving-radius-arc', 'N', 'Reference radius of an arc').pt('O', 0, 0, true).pt('S', 5, 0, true).pt('E', 0.3, 4.8).arc('A1', 'O', 'S', 'E', 4);
  c.con('distance_x', { p1: 'O', p2: 'E' }, 0);
  const n10 = c.con('radius', { curve: 'A1' }, 4, { driving: false });
  add(c.expect({ driven: { [n10]: 5 } }).done());

  c = new Case('N11-nondriving-on-free-line', 'N', 'Reference length on a free line: nothing moves, DOF stays 4').pt('P1', 0, 0).pt('P2', 7, 1).line('L1', 'P1', 'P2');
  const n11 = c.con('length', { line: 'L1' }, 3, { driving: false });
  add(c.expect({ driven: { [n11]: Math.sqrt(50) } }).checks([{ kind: 'unchanged', ids: ['P1', 'P2'], tol: 1e-9 }]).done());
}

// ================================================================================================
// T determination (DOF counting)
// ================================================================================================
{
  let c = new Case('T01-free-line', 'T', 'A free line has 4 degrees of freedom').pt('P1', 0, 0).pt('P2', 7, 3).line('L1', 'P1', 'P2');
  add(c.expect({ dof: 4 }).checks([{ kind: 'unchanged', ids: ['P1', 'P2'], tol: 1e-9 }]).done());

  c = new Case('T02-rectangle-to-zero-dof', 'T', 'Rectangle constrained step by step to 0 DOF, then a redundant and a contradicting dimension',
    'Steps: free (8) -> horizontals (6) -> verticals (4) -> width (3) -> height (2) -> fix corner (0) -> redundant top length (0, redundant) -> contradicting top length (conflict).')
    .pt('P1', 0, 0).pt('P2', 20, 1).pt('P3', 19, 12).pt('P4', 1, 10).line('L1', 'P1', 'P2').line('L2', 'P2', 'P3').line('L3', 'P3', 'P4').line('L4', 'P4', 'P1');
  const h1 = c.con('horizontal', { line: 'L1' }, undefined, { enabled: false });
  const h2 = c.con('horizontal', { line: 'L3' }, undefined, { enabled: false });
  const v1 = c.con('vertical', { line: 'L2' }, undefined, { enabled: false });
  const v2 = c.con('vertical', { line: 'L4' }, undefined, { enabled: false });
  const w = c.con('length', { line: 'L1' }, 20, { enabled: false });
  const hh = c.con('length', { line: 'L2' }, 10, { enabled: false });
  const fx = c.con('fix', { point: 'P1', x: 0, y: 0 }, undefined, { enabled: false });
  const red = c.con('length', { line: 'L3' }, 20, { enabled: false });
  const bad = c.con('length', { line: 'L3' }, 25, { enabled: false });
  const all = [h1, h2, v1, v2, w, fx, red];
  c.steps([
    { id: 's1', label: 'horizontal bottom and top', enable: [h1, h2], expect: { dof: 6 } },
    { id: 's2', label: 'vertical left and right', enable: [v1, v2], expect: { dof: 4 } },
    { id: 's3', label: 'width 20', enable: [w], expect: { dof: 3 } },
    { id: 's4', label: 'height 10', enable: [hh], expect: { dof: 2 } },
    { id: 's5', label: 'fix P1 at the origin', enable: [fx], expect: { dof: 0 } },
    { id: 's6', label: 'redundant: top length = 20 (consistent)', enable: [red], expect: { dof: 0, redundant: { mode: 'within', ids: [h1, h2, v1, v2, w, red], min: 1, count: 1 } } },
    { id: 's7', label: 'contradiction: top length = 25 instead', disable: [red], enable: [bad], expect: { solved: false, conflicting: { mode: 'within', ids: [h1, h2, v1, v2, w, bad], min: 1 } } },
  ]);
  void all;
  add(c.expect({ step0: { dof: 8 }, status_ok: ['Success', 'Converged'], solved: true, dof: null, conflicting: { mode: 'any' }, redundant: { mode: 'any' } }).done());
}

// ================================================================================================
// C conflicts and redundancy
// ================================================================================================
{
  let c = new Case('C01-contradicting-lengths', 'C', 'Two length dimensions of one line (10 and 20)').pt('P1', 0, 0, true).pt('P2', 10, 0.5).line('L1', 'P1', 'P2');
  const a = c.con('length', { line: 'L1' }, 10), b = c.con('length', { line: 'L1' }, 20);
  add(c.expect({ solved: false, dof: null, conflicting: { mode: 'exact', ids: [a, b] } }).done());

  c = new Case('C02a-horizontal-vertical-length', 'C', 'Horizontal + vertical + length 10 on one line (contradiction)').pt('P1', 0, 0, true).pt('P2', 8, 3).line('L1', 'P1', 'P2');
  const h = c.con('horizontal', { line: 'L1' }), v = c.con('vertical', { line: 'L1' }), l = c.con('length', { line: 'L1' }, 10);
  add(c.expect({ solved: false, dof: null, conflicting: { mode: 'within', ids: [h, v, l], min: 1 } }).done());

  c = new Case('C02b-horizontal-vertical-degenerate', 'C', 'Horizontal + vertical on one free line (no contradiction, the line collapses to a point)', 'Mathematically consistent (dx = 0 and dy = 0). A CAD would have to refuse this; we only record what the solver does.')
    .pt('P1', 1, 1).pt('P2', 8, 3).line('L1', 'P1', 'P2');
  c.con('horizontal', { line: 'L1' }); c.con('vertical', { line: 'L1' });
  add(c.checks([{ kind: 'holds', constraint: { type: 'coincident', p1: 'P1', p2: 'P2' } }]).done());

  c = new Case('C03-contradicting-triangle', 'C', 'Triangle with sides 3, 4 and 10 (violates the triangle inequality)', 'No structural dependency at the start: diagnosis by Jacobian rank (GCS.cpp:4738) cannot name the conflict, so the conflict check is soft.')
    .pt('P1', 0, 0, true).pt('P2', 3.2, 0.2).pt('P3', 0.5, 4.1).line('L12', 'P1', 'P2').line('L23', 'P2', 'P3').line('L31', 'P3', 'P1');
  const t1 = c.con('length', { line: 'L12' }, 3), t2 = c.con('length', { line: 'L23' }, 4), t3 = c.con('length', { line: 'L31' }, 10);
  add(c.expect({ solved: false, dof: null, conflicting: { mode: 'within', ids: [t1, t2, t3], min: 1 }, soft: ['conflicting'] }).done());

  c = new Case('C04-redundant-parallel', 'C', 'Both lines horizontal AND parallel: one of the three constraints is redundant (consistent)')
    .pt('P1', 0, 0).pt('P2', 10, 1).pt('P3', 0, 5).pt('P4', 9, 6.5).line('L1', 'P1', 'P2').line('L2', 'P3', 'P4');
  const r1 = c.con('horizontal', { line: 'L1' }), r2 = c.con('horizontal', { line: 'L2' }), r3 = c.con('parallel', { l1: 'L1', l2: 'L2' });
  add(c.expect({ dof: 6, status_ok: ['Success', 'Converged'], redundant: { mode: 'within', ids: [r1, r2, r3], min: 1, count: 1 } }).done(1));

  c = new Case('C05-duplicate-dimension', 'C', 'The same horizontal distance dimensioned twice (consistent duplicate)').pt('P1', 0, 0, true).pt('P2', 9, 1);
  const d1 = c.con('distance_x', { p1: 'P1', p2: 'P2' }, 10), d2 = c.con('distance_x', { p1: 'P1', p2: 'P2' }, 10);
  add(c.expect({ dof: 1, status_ok: ['Success', 'Converged'], redundant: { mode: 'within', ids: [d1, d2], min: 1, count: 1 } }).done(1));

  c = new Case('C06-partially-redundant', 'C', 'Symmetry (2 equations) plus midpoint (2 equations) share one equation: partially redundant',
    'symmetric(A,B about the vertical axis) = {A.y = B.y, A.x + B.x = 0}; midpoint(M of AB, M = (0,5)) = {x sum = 0, y sum = 10}. One equation is shared, the other of each tag is not.')
    .pt('X1', 0, 0, true).pt('X2', 0, 10, true).line('Axis', 'X1', 'X2').pt('A', -2, 6).pt('B', 3, 4).line('LAB', 'A', 'B').pt('M', 0, 5, true);
  const s1 = c.con('symmetric', { p1: 'A', p2: 'B', line: 'Axis' }), s2 = c.con('midpoint', { point: 'M', line: 'LAB' });
  add(c.expect({ dof: 1, redundant: { mode: 'any' }, partially_redundant: { mode: 'within', ids: [s1, s2], min: 1, count: 1 }, status_ok: ['Success', 'Converged'], soft: ['redundant', 'partially_redundant'] }).done(1));
}

// ================================================================================================
// B B-splines
// ================================================================================================
const BEZ = { weights: [1, 1, 1, 1], knots: [0, 1], mult: [4, 4], degree: 3 };
{
  let c = new Case('B01-spline-end-on-line', 'B', 'Open cubic Bezier: its first pole coincident with the end of a line', 'Pole 1 is the curve start (clamped knots), so a point-point coincident is enough.')
    .pt('Q1', -6, -3, true).pt('Q2', 0.4, 0.3).line('L1', 'Q1', 'Q2').pt('P1', 0, 0, true).pt('P2', 2, 5).pt('P3', 6, 5.5).pt('P4', 9, 0.3)
    .bspline('B1', ['P1', 'P2', 'P3', 'P4'], BEZ.weights, BEZ.knots, BEZ.mult, 3, false);
  c.con('coincident', { p1: 'Q2', p2: 'P1' }); add(c.done());

  c = new Case('B02-spline-tangent-to-line-at-end', 'B', 'Open cubic Bezier: line ends tangentially at the spline start (G1)', 'FreeCAD refuses slope constraints at end knots (Sketch.cpp:3091); the end tangent is the direction of the first control leg (Geo.cpp:713).')
    .pt('Q1', -6, -3, true).pt('Q2', 0.3, 0.2).line('L1', 'Q1', 'Q2').pt('P1', 0, 0, true).pt('P2', 2, 5).pt('P3', 6, 5.5).pt('P4', 9, 0.3)
    .bspline('B1', ['P1', 'P2', 'P3', 'P4'], BEZ.weights, BEZ.knots, BEZ.mult, 3, false);
  c.con('tangent_at', { a: 'L1', b: 'B1', p1: 'Q2', p2: 'P1' });
  c.checks([{ kind: 'holds', constraint: { type: 'no_cusp', a: 'L1', b: 'B1', p1: 'Q2', p2: 'P1' } }]); add(c.done());

  // periodic closed cubic, 6 poles
  {
    const pts = [[6, 0], [3.2, 5.4], [-3.3, 5.1], [-6.2, 0.3], [-2.9, -5.3], [3.4, -5.0]];
    c = new Case('B03a-periodic-spline-dimension', 'B', 'Periodic (closed) cubic B-spline, 6 poles; distance between pole 1 and pole 4 = 12', 'Periodic knots 0..6, multiplicity 1 each, 6 poles (OCCT convention used by planegcs).');
    pts.forEach((p, i) => c.pt(`P${i + 1}`, p[0], p[1], i === 0));
    c.bspline('B1', pts.map((_, i) => `P${i + 1}`), Array(6).fill(1), [0, 1, 2, 3, 4, 5, 6], Array(7).fill(1), 3, true);
    c.con('distance', { p1: 'P1', p2: 'P4' }, 12);
    c.checks([{ kind: 'closed_curve', bspline: 'B1' }]); add(c.done());

    const spec = { degree: 3, knots: [0, 1, 2, 3, 4, 5, 6], mult: Array(7).fill(1), weights: Array(6).fill(1), periodic: true };
    const tgt = [5.2, -2.4];
    const u0 = bsplineClosest(spec, pts, tgt).u;
    c = new Case('B03b-periodic-spline-point-on-curve', 'B', 'Point on a periodic cubic B-spline (poles fixed)');
    pts.forEach((p, i) => c.pt(`P${i + 1}`, p[0], p[1], true));
    c.pt('Pt', tgt[0], tgt[1]).bspline('B1', pts.map((_, i) => `P${i + 1}`), Array(6).fill(1), [0, 1, 2, 3, 4, 5, 6], Array(7).fill(1), 3, true);
    c.con('point_on_curve', { point: 'Pt', curve: 'B1', u0 }); add(c.done());
  }

  c = new Case('B04-quadratic-spline-tangent-at-interior-knot', 'B', 'Degree 2 spline with interior knots: a line touches it tangentially at knot index 2', 'Interior knot multiplicity 1 < degree 2, so the slope is defined there (ConstraintSlopeAtBSplineKnot, Constraints.cpp:262).')
    .pt('P1', 0, 0, true).pt('P2', 2, 4).pt('P3', 5, 5).pt('P4', 8, 3.5).pt('P5', 10, 0, true)
    .bspline('B1', ['P1', 'P2', 'P3', 'P4', 'P5'], [1, 1, 1, 1, 1], [0, 1, 2, 3], [3, 1, 1, 3], 2, false)
    .pt('Q1', 1, 6.8, true).pt('Q2', 11, 2.2).line('L1', 'Q1', 'Q2');
  c.con('tangent_at_knot', { line: 'L1', bspline: 'B1', knot: 2 }); add(c.done());

  c = new Case('B05-cubic-spline-tangent-at-c1-knot', 'B', 'Cubic spline, interior knot multiplicity 2 (C1): a line touches it tangentially at that knot', 'Knots 0,1,2 with multiplicities 4,2,4: sum 10 = 6 poles + degree 3 + 1.')
    .pt('P1', 0, 0, true).pt('P2', 1.5, 3).pt('P3', 3.5, 4.5).pt('P4', 6, 4).pt('P5', 8.5, 2.5).pt('P6', 10, 0, true)
    .bspline('B1', ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'], Array(6).fill(1), [0, 1, 2], [4, 2, 4], 3, false)
    .pt('Q1', 1, 6.5, true).pt('Q2', 10, 5).line('L1', 'Q1', 'Q2');
  c.con('tangent_at_knot', { line: 'L1', bspline: 'B1', knot: 1 }); add(c.done());

  c = new Case('B06-knot-multiplicity-equals-degree', 'B', 'Cubic spline with an interior knot of multiplicity 3 (C0 kink at pole 4): a line tangent at the kink', 'The slope at a kink is not defined: FreeCAD refuses it (Sketch.cpp:3081-3103) and ConstraintSlopeAtBSplineKnot asserts numpoles >= 2. A track may answer "no"; if it answers "yes" the checker tests both one-sided slopes.')
    .pt('P1', 0, 0, true).pt('P2', 1.5, 3).pt('P3', 3, 4.5).pt('P4', 5, 4).pt('P5', 7, 3).pt('P6', 8.5, 1).pt('P7', 10, 0, true)
    .bspline('B1', ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'], Array(7).fill(1), [0, 1, 2], [4, 3, 4], 3, false)
    .pt('Q1', 3, 6.5, true).pt('Q2', 9, 5.5).line('L1', 'Q1', 'Q2');
  c.con('tangent_at_knot', { line: 'L1', bspline: 'B1', knot: 1 }); add(c.done());

  {
    const w = Math.SQRT1_2;
    const spec = { degree: 2, knots: [0, 1], mult: [3, 3], weights: [1, w, 1], periodic: false };
    const poles = [[5, 0], [5, 5], [0, 5]];
    const tgt = [3.6, 3.7];
    const u0 = bsplineClosest(spec, poles, tgt).u;
    c = new Case('B07-rational-quarter-circle', 'B', 'Rational quadratic B-spline = exact quarter circle of radius 5; a free point on it must end up at distance 5 from the origin', 'Tests weights: the poles carry weights 1, sqrt(2)/2, 1.')
      .pt('O', 0, 0, true).pt('P1', 5, 0, true).pt('P2', 5, 5, true).pt('P3', 0, 5, true).pt('Pt', tgt[0], tgt[1])
      .bspline('B1', ['P1', 'P2', 'P3'], [1, w, 1], [0, 1], [3, 3], 2, false);
    c.con('point_on_curve', { point: 'Pt', curve: 'B1', u0 });
    add(c.checks([{ kind: 'holds', constraint: { type: 'distance', p1: 'O', p2: 'Pt', value: 5 }, tol: 1e-6 }]).done());
  }
}

// chain of n links of the given length starting at the fixed origin Q0, bent by dth per link, with a
// seeded random offset (so the start is off); the tip is Q<n>
function addChain(c, n, link, dth, seed) {
  const rand = rng(seed);
  c.pt('Q0', 0, 0, true);
  let x = 0, y = 0;
  for (let i = 1; i <= n; i++) {
    x += link * Math.cos(dth * (i - 1)); y += link * Math.sin(dth * (i - 1));
    c.pt('Q' + i, x + (rand() - 0.5) * 0.6, y + (rand() - 0.5) * 0.6);
  }
  for (let i = 1; i <= n; i++) c.line('L' + i, 'Q' + (i - 1), 'Q' + i);
  for (let i = 1; i <= n; i++) c.con('length', { line: 'L' + i }, link);
}
// drag path: starts at the initial position of the tip and spirals outwards in small steps
function spiralDrag(c, tip, steps, dAngle, rEnd, tol) {
  const e = c.def.elements.find((q) => q.id === tip);
  const r0 = Math.hypot(e.x, e.y), a0 = Math.atan2(e.y, e.x);
  return Array.from({ length: steps }, (_, i) => {
    const a = a0 + dAngle * (i + 1), r = r0 + ((rEnd - r0) * (i + 1)) / steps;
    const x = r * Math.cos(a), y = r * Math.sin(a);
    return { id: 's' + (i + 1), label: 'mouse ' + (i + 1), drag: { point: tip, x, y }, expect: { points: { [tip]: [x, y] }, tol } };
  });
}

// ================================================================================================
// S stability sequences
// ================================================================================================
{
  let c = new Case('S01-triangle-side-sweep', 'S', 'Isosceles triangle, one side stepped 10 -> 100 in 10 steps, each solve starts from the previous result', 'The apex P3 must stay above the base (no mirror flip) and move continuously.')
    .pt('P1', 0, 0, true).pt('P2', 100, 0).pt('P3', 80, 25).line('L12', 'P1', 'P2').line('L23', 'P2', 'P3').line('L31', 'P3', 'P1');
  c.con('horizontal', { line: 'L12' }); c.con('length', { line: 'L12' }, 100); c.con('length', { line: 'L31' }, 100);
  const side = c.con('length', { line: 'L23' }, 10);
  c.steps(Array.from({ length: 9 }, (_, i) => ({ id: `s${i + 1}`, label: `side = ${20 + i * 10}`, set: { [side]: 20 + i * 10 } })));
  c.def.step_checks = [{ kind: 'orientation', points: ['P1', 'P2', 'P3'], sign: 1 }, { kind: 'max_jump', points: ['P3'], max: 14 }];
  add(c.expect({ dof: 0, step0: { dof: 0 } }).done());

  c = new Case('S02-line-angle-sweep', 'S', 'Line of length 40 rotated in 15 degree steps from 10 to 355 degrees (passes +-pi)', 'Angles are compared modulo 2*pi; the free end must move along the circle without jumping.')
    .pt('P1', 0, 0, true).pt('P2', 30, 15).line('L1', 'P1', 'P2');
  c.con('length', { line: 'L1' }, 40); const ang = c.con('angle_line', { line: 'L1' }, deg(10));
  c.steps(Array.from({ length: 23 }, (_, i) => ({ id: `s${i + 1}`, label: `angle = ${25 + i * 15} deg`, set: { [ang]: deg(25 + i * 15) } })));
  c.def.step_checks = [{ kind: 'max_jump', points: ['P2'], max: 12 }];
  add(c.expect({ dof: 0, step0: { dof: 0 } }).done());

  c = new Case('S03-circle-tangent-radius-sweep', 'S', 'Circle tangent to a line, radius stepped 10 -> 50 (centre x fixed at 0); it must stay on the same side of the line')
    .pt('A', -100, 0, true).pt('B', 100, 0, true).line('L1', 'A', 'B').pt('M', 0, 0, true).pt('C', 0, 6).circle('K1', 'C', 5);
  c.con('tangent', { a: 'L1', b: 'K1' }); const rad = c.con('radius', { curve: 'K1' }, 5); c.con('distance_x', { p1: 'M', p2: 'C' }, 0);
  c.steps(Array.from({ length: 9 }, (_, i) => ({ id: `s${i + 1}`, label: `radius = ${10 + i * 5}`, set: { [rad]: 10 + i * 5 } })));
  c.def.step_checks = [{ kind: 'orientation', points: ['A', 'B', 'C'], sign: 1 }, { kind: 'max_jump', points: ['C'], max: 6 }];
  add(c.expect({ dof: 0, step0: { dof: 0 } }).done());

  // drag: line of fixed length dragged by the mouse to points outside its reach (projection) around a circle
  c = new Case('S04-drag-fixed-length-line', 'S', 'Drag the free end of a line of fixed length 10 around, mouse always at distance 14 (end must follow along the circle of radius 10)', 'Drag = temporary constraints (tag -1 / temporary:true) on the point; they must not make the system fail and are not kept.')
    .pt('P1', 0, 0, true).pt('P2', 10, 0).line('L1', 'P1', 'P2');
  c.con('length', { line: 'L1' }, 10);
  c.steps(Array.from({ length: 12 }, (_, i) => {
    const a = deg(30 * (i + 1));
    return { id: `s${i + 1}`, label: `mouse at ${30 * (i + 1)} deg`, drag: { point: 'P2', x: 14 * Math.cos(a), y: 14 * Math.sin(a) }, expect: { points: { P2: [10 * Math.cos(a), 10 * Math.sin(a)] }, tol: 1e-3 } };
  }));
  add(c.expect({ dof: 1, step0: { dof: 1 } }).done());

  // drag chain: 10 links of length 5, tip dragged over reachable positions
  c = new Case('S05-drag-chain-reachable', 'S', 'Chain of 10 links (length 5), origin fixed; the tip is dragged in small steps along an outward spiral inside the reach: it must reach the mouse position', 'Dragging a point with abundant DOF: expected tip = mouse within 1e-3. The chain starts slightly curved and a little off in length.');
  addChain(c, 10, 5, 0.12, 71);
  c.steps(spiralDrag(c, 'Q10', 30, 0.08, 40, 1e-3));
  add(c.expect({ dof: 10, step0: { dof: 10 } }).done());
}

// ================================================================================================
// P performance (explicit large sketches in separate files)
// ================================================================================================
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// rows x cols grid of rectangles. Each rectangle: 4 points + 4 lines, H/V on all sides, width and
// height dimensions; neighbours are chained by coincident corners (a tree, so nothing is redundant);
// the first corner is fixed. Start positions are the nominal ones plus a seeded random offset.
function gridCase(id, rows, cols, seed, title) {
  const rand = rng(seed);
  const c = new Case(id, 'P', title, `Generated by cases/build-cases.mjs (seed ${seed}); ${rows}x${cols} rectangles x 8 elements.`);
  const off = (s) => (rand() - 0.5) * 2 * s;
  const W = (r, k) => 8 + ((r * 7 + k * 3) % 7); // widths 8..14
  const H = (r, k) => 6 + ((r * 5 + k * 2) % 5); // heights 6..10
  const x0 = [];
  const rectXY = (r, k) => {
    // nominal bottom-left corner: row r stacks above row r-1 using the heights of column 0 chain
    let x = 0, y = 0;
    for (let j = 0; j < k; j++) x += W(r, j);
    for (let j = 0; j < r; j++) y += H(j, 0);
    return [x, y];
  };
  void x0;
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
    const [x, y] = rectXY(r, k);
    const w = W(r, k), h = H(r, k);
    const id4 = (n) => `R${r}_${k}${n}`;
    c.pt(id4('BL'), x + off(1.5), y + off(1.5)); c.pt(id4('BR'), x + w + off(1.5), y + off(1.5));
    c.pt(id4('TR'), x + w + off(1.5), y + h + off(1.5)); c.pt(id4('TL'), x + off(1.5), y + h + off(1.5));
    c.line(id4('b'), id4('BL'), id4('BR')); c.line(id4('r'), id4('BR'), id4('TR')); c.line(id4('t'), id4('TR'), id4('TL')); c.line(id4('l'), id4('TL'), id4('BL'));
  }
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
    const n = (s) => `R${r}_${k}${s}`;
    c.con('horizontal', { line: n('b') }); c.con('horizontal', { line: n('t') });
    c.con('vertical', { line: n('r') }); c.con('vertical', { line: n('l') });
    c.con('length', { line: n('b') }, W(r, k)); c.con('length', { line: n('l') }, H(r, k));
    if (r === 0 && k === 0) c.con('fix', { point: n('BL'), x: 0, y: 0 });
    else if (k > 0) c.con('coincident', { p1: n('BL'), p2: `R${r}_${k - 1}BR` });
    else c.con('coincident', { p1: n('BL'), p2: `R${r - 1}_0TL` });
  }
  return c;
}
{
  const g = [['P01-grid-50', 1, 6, 11, 'Connected chain of 6 fully dimensioned rectangles (48 elements)'],
             ['P02-grid-200', 5, 5, 22, 'Connected 5x5 grid of fully dimensioned rectangles (200 elements)'],
             ['P03-grid-1000', 5, 25, 33, 'Connected 5x25 grid of fully dimensioned rectangles (1000 elements)']];
  fs.mkdirSync(here, { recursive: true });
  for (const [id, rows, cols, seed, title] of g) {
    const def = gridCase(id, rows, cols, seed, title).expect({ dof: 0 }).done();
    def.tol = { length: 1e-5 };
    const file = `large-${id.toLowerCase()}.json`;
    fs.writeFileSync(path.join(here, file), JSON.stringify(def));
    cases.push({ id, group: 'P', title, file, elements_count: def.elements.length, constraints_count: def.constraints.length });
  }
  // drag timing sequence: 40 links, 100 mouse positions
  const c = new Case('P04-drag-chain-100-steps', 'P', 'Chain of 40 links (length 5), origin fixed; 100 drag steps of the tip along an outward spiral (timing of a drag sequence)', 'Positions stay inside the reach (200).');
  addChain(c, 40, 5, 0.03, 72);
  c.steps(spiralDrag(c, 'Q40', 100, 0.03, 150, 1e-2));
  add(c.expect({ dof: 40, step0: { dof: 40 } }).done());
}

// ================================================================================================
// sanity checks of the catalogue itself
// ================================================================================================
const ids = new Set();
for (const c of cases) {
  if (ids.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
  ids.add(c.id);
}
for (const c of cases) {
  if (c.file) continue;
  const el = new Map(c.elements.map((e) => [e.id, e]));
  for (const e of c.elements) {
    for (const k of ['p1', 'p2', 'center', 'start', 'end']) if (e[k] !== undefined && !el.has(e[k])) throw new Error(`${c.id}: ${e.id}.${k} -> unknown ${e[k]}`);
    if (e.type === 'bspline') for (const p of e.poles) if (!el.has(p)) throw new Error(`${c.id}: ${e.id} pole ${p} unknown`);
  }
  const cids = new Set(c.constraints.map((x) => x.id));
  for (const x of c.constraints) {
    for (const [k, v] of Object.entries(x)) {
      if (['id', 'type', 'value', 'driving', 'enabled', 'x', 'y', 'u0', 'knot'].includes(k)) continue;
      if (!el.has(v)) throw new Error(`${c.id}: constraint ${x.id}.${k} -> unknown element ${v}`);
    }
  }
  for (const s of c.steps || []) for (const k of [...(s.enable || []), ...(s.disable || []), ...Object.keys(s.set || {})]) if (!cids.has(k)) throw new Error(`${c.id}: step ${s.id} -> unknown constraint ${k}`);
  // a spline must have the right number of knots and poles
  for (const e of c.elements) if (e.type === 'bspline') {
    const sumMult = e.mult.reduce((a, b) => a + b, 0);
    const nPoles = e.poles.length;
    const expected = e.periodic ? sumMult - e.mult[e.mult.length - 1] : sumMult - e.degree - 1;
    if (e.periodic ? nPoles !== sumMult - e.mult[e.mult.length - 1] : nPoles !== expected) throw new Error(`${c.id}: ${e.id} has ${nPoles} poles but knots/multiplicities need ${expected}`);
    if (e.weights.length !== nPoles) throw new Error(`${c.id}: ${e.id} weights/poles mismatch`);
  }
}
// make sure the initial geometry can be evaluated by the checker's own context (no missing ids)
void Ctx;

const doc = {
  format: 1,
  title: 'HalfCube solver test: solver-neutral case catalogue',
  units: 'millimetres and radians; right-handed, y up; arcs run counter-clockwise from start to end',
  tolerances: { length: 1e-6, angle: 1e-6, curvature: 1e-5 },
  cases,
};
fs.writeFileSync(path.join(here, 'cases.json'), JSON.stringify(doc, null, 1));
const n = cases.length;
const algoEntries = cases.reduce((s, c) => s + (c.run_algorithms ? c.run_algorithms.length : 1), 0);
console.log(`wrote cases.json: ${n} cases (${algoEntries} result entries incl. algorithm variants)`);
for (const c of cases) console.log(`${c.id.padEnd(46)} dof=${c.file ? 0 : c.expect.dof}${c.file ? `  (${c.elements_count} elements, ${c.constraints_count} constraints)` : ''}`);
