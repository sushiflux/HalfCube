// Translation of the solver-neutral case catalogue into the JSON primitives of @salusoft89/planegcs.
// Used by run.mjs (the track runner) and the probe scripts. Pure JavaScript: it builds the list of primitives
// ("plan") but never calls the solver and never looks at the expectations of a case.

import { bsplineEval } from '../check/lib.mjs';

const TWO_PI = 2 * Math.PI;
const wrap2Pi = (a) => { let r = a % TWO_PI; if (r < 0) r += TWO_PI; return r; };

export class Unsupported extends Error {}

// ------------------------------------------------------------------------------------------------
// state of the constraints in step k (same semantics as the checker: cumulative set/enable/disable)
// ------------------------------------------------------------------------------------------------

export function effectiveState(caseDef, k) {
  const st = new Map();
  for (const c of caseDef.constraints) st.set(c.id, { c, enabled: c.enabled !== false, value: c.value, x: c.x, y: c.y, driving: c.driving !== false });
  for (let j = 1; j <= k; j++) {
    const s = (caseDef.steps || [])[j - 1];
    if (!s) continue;
    for (const id of s.disable || []) st.get(id).enabled = false;
    for (const id of s.enable || []) st.get(id).enabled = true;
    for (const [id, v] of Object.entries(s.set || {})) {
      const t = st.get(id);
      if (typeof v === 'number') t.value = v; else { if (v.value !== undefined) t.value = v.value; if (v.x !== undefined) t.x = v.x; if (v.y !== undefined) t.y = v.y; }
    }
  }
  return st;
}

export function initialGeometry(caseDef) {
  const g = {};
  for (const e of caseDef.elements) {
    if (e.type === 'point') g[e.id] = { x: e.x, y: e.y };
    else if (e.type === 'circle' || e.type === 'arc') g[e.id] = { radius: e.radius };
  }
  return g;
}

// ------------------------------------------------------------------------------------------------
// translation: neutral case -> list of package primitives ("plan")
// ------------------------------------------------------------------------------------------------

// property of the package primitive that holds the value of a dimension (read back for non-driving ones)
export const VALUE_PROP = {
  distance: ['p2p_distance', 'distance'], length: ['p2p_distance', 'distance'], distance_point_line: ['p2l_distance', 'distance'],
  distance_x: ['difference', 'difference'], distance_y: ['difference', 'difference'],
  angle: ['l2l_angle_ll', 'angle'], angle_line: ['p2p_angle', 'angle'],
  radius: [null, 'radius'], diameter: [null, 'diameter'], arc_length: ['arc_length', 'dist'],
};

export function makePlan(caseDef, state, geom, drag) {
  const E = new Map(caseDef.elements.map((e) => [e.id, e]));
  const el = (id) => { const e = E.get(id); if (!e) throw new Error(`unknown element ${id}`); return e; };
  const ops = [];            // {kind:'prim', def} | {kind:'param', name, value}
  const aux = [];            // helper geometry, pushed after the case geometry and before the constraints
  const owner = new Map();   // primitive id -> case constraint id (null = internal helper)
  const classOf = new Map(); // case constraint id -> 'direct' | 'composed'
  const mapping = new Map(); // neutral type -> Set of primitive types
  const valueRef = new Map();// case constraint id -> { prim, prop }
  const internalLabel = new Map();

  // --- geometry ---
  for (const e of caseDef.elements) {
    if (e.type === 'point') ops.push({ kind: 'prim', def: { id: e.id, type: 'point', x: geom[e.id].x, y: geom[e.id].y, fixed: !!e.fixed } });
  }
  for (const e of caseDef.elements) {
    if (e.type === 'line') ops.push({ kind: 'prim', def: { id: e.id, type: 'line', p1_id: e.p1, p2_id: e.p2 } });
    else if (e.type === 'circle') ops.push({ kind: 'prim', def: { id: e.id, type: 'circle', c_id: e.center, radius: geom[e.id].radius } });
    else if (e.type === 'arc') {
      const c = geom[e.center], s = geom[e.start], t = geom[e.end];
      const sa = Math.atan2(s.y - c.y, s.x - c.x);
      const ea = sa + (wrap2Pi(Math.atan2(t.y - c.y, t.x - c.x) - sa) || TWO_PI); // end angle > start angle (ccw sweep)
      ops.push({ kind: 'prim', def: { id: e.id, type: 'arc', c_id: e.center, start_id: e.start, end_id: e.end, radius: geom[e.id].radius, start_angle: sa, end_angle: ea } });
      const rid = `${e.id}~rules`;
      ops.push({ kind: 'prim', def: { id: rid, type: 'arc_rules', a_id: e.id, driving: true } });
      owner.set(rid, null); internalLabel.set(rid, `arc_rules of ${e.id}`);
    } else if (e.type === 'bspline') {
      ops.push({ kind: 'prim', def: { id: e.id, type: 'bspline', pole_ids: e.poles, weights: e.weights, knots: e.knots, mult: e.mult, degree: e.degree, periodic: e.periodic } });
    }
  }

  // --- helpers used by the translations ---
  // sign of the end at which point `pid` sits on curve `cid`: +1 = start (parameter direction leaves the junction)
  const endSign = (cid, pid) => {
    const e = el(cid);
    if (e.type === 'line') return e.p1 === pid ? 1 : e.p2 === pid ? -1 : (() => { throw new Unsupported(`point ${pid} is no end of line ${cid}`); })();
    if (e.type === 'arc') return e.start === pid ? 1 : e.end === pid ? -1 : (() => { throw new Unsupported(`point ${pid} is no end of arc ${cid}`); })();
    if (e.type === 'bspline') return e.poles[0] === pid ? 1 : e.poles[e.poles.length - 1] === pid ? -1 : (() => { throw new Unsupported(`point ${pid} is no end pole of spline ${cid}`); })();
    throw new Unsupported(`junction at a ${e.type} has no end point`);
  };
  // curve id usable in angle_via_point: lines, circles and arcs directly; a spline end through an auxiliary
  // line along its first / last control leg (the end tangent of a clamped spline), because the package's
  // spline normal needs the point to equal the internal start/end helper by coordinates (BSpline::CalculateNormal: Geo.cpp:713-731 in FreeCAD 1.1.4, :730 in the package snapshot)
  const tangentCurve = (cid, pid, cons) => {
    const e = el(cid);
    if (e.type !== 'bspline') return cid;
    const first = e.poles[0] === pid;
    const [a, b] = first ? [e.poles[0], e.poles[1]] : [e.poles[e.poles.length - 2], e.poles[e.poles.length - 1]];
    const id = `${cons.id}~${first ? 'startleg' : 'endleg'}`;
    aux.push({ kind: 'prim', def: { id, type: 'line', p1_id: a, p2_id: b } });
    owner.set(id, null); internalLabel.set(id, `control-leg line of ${cid}`);
    return id;
  };
  const isCircleLike = (id) => ['circle', 'arc'].includes(el(id).type);
  const equalRadiusPrim = (a, b, drv) => {
    const ta = el(a).type, tb = el(b).type;
    if (ta === 'circle' && tb === 'circle') return { type: 'equal_radius_cc', c1_id: a, c2_id: b, driving: drv };
    if (ta === 'circle' && tb === 'arc') return { type: 'equal_radius_ca', c1_id: a, a2_id: b, driving: drv };
    if (ta === 'arc' && tb === 'circle') return { type: 'equal_radius_ca', c1_id: b, a2_id: a, driving: drv };
    if (ta === 'arc' && tb === 'arc') return { type: 'equal_radius_aa', a1_id: a, a2_id: b, driving: drv };
    throw new Unsupported(`equal radius between ${ta} and ${tb}`);
  };

  // --- constraints ---
  const defsOf = (c, st) => {
    const drv = st.driving;
    const v = st.value;
    switch (c.type) {
      case 'horizontal': return { cls: 'direct', defs: [c.line ? { type: 'horizontal_l', l_id: c.line, driving: true } : { type: 'horizontal_pp', p1_id: c.p1, p2_id: c.p2, driving: true }] };
      case 'vertical': return { cls: 'direct', defs: [c.line ? { type: 'vertical_l', l_id: c.line, driving: true } : { type: 'vertical_pp', p1_id: c.p1, p2_id: c.p2, driving: true }] };
      case 'coincident': return { cls: 'direct', defs: [{ type: 'p2p_coincident', p1_id: c.p1, p2_id: c.p2, driving: true }] };
      case 'point_on_curve': {
        const t = el(c.curve).type;
        if (t === 'line') return { cls: 'direct', defs: [{ type: 'point_on_line_pl', p_id: c.point, l_id: c.curve, driving: true }] };
        if (t === 'circle') return { cls: 'direct', defs: [{ type: 'point_on_circle', p_id: c.point, c_id: c.curve, driving: true }] };
        if (t === 'arc') return { cls: 'direct', defs: [{ type: 'point_on_arc', p_id: c.point, a_id: c.curve, driving: true }] };
        if (t === 'bspline') {
          // the curve parameter must be a free sketch parameter, otherwise the point is pinned to C(u0)
          const name = `u_${c.id}`;
          ops_params.push({ kind: 'param', name, value: c.u0 });
          return { cls: 'direct', defs: [{ type: 'point_on_bspline', p_id: c.point, b_id: c.curve, pointparam: name, driving: true }] };
        }
        throw new Unsupported(`point on ${t}`);
      }
      case 'tangent': {
        let a = c.a, b = c.b;
        let ta = el(a).type, tb = el(b).type;
        if (tb === 'line' || (ta === 'arc' && tb === 'circle')) { [a, b] = [b, a]; [ta, tb] = [tb, ta]; }
        if (ta === 'line' && tb === 'circle') return { cls: 'direct', defs: [{ type: 'tangent_lc', l_id: a, c_id: b, driving: true }] };
        if (ta === 'line' && tb === 'arc') return { cls: 'direct', defs: [{ type: 'tangent_la', l_id: a, a_id: b, driving: true }] };
        if (ta === 'circle' && tb === 'circle') return { cls: 'direct', defs: [{ type: 'tangent_cc', c1_id: a, c2_id: b, driving: true }] };
        if (ta === 'circle' && tb === 'arc') return { cls: 'direct', defs: [{ type: 'tangent_ca', c_id: a, a_id: b, driving: true }] };
        if (ta === 'arc' && tb === 'arc') return { cls: 'direct', defs: [{ type: 'tangent_aa', a1_id: a, a2_id: b, driving: true }] };
        throw new Unsupported(`tangent between ${ta} and ${tb}`);
      }
      case 'tangent_at': {
        // coincident end points + tangent directions equal or opposite as the curves' parameter directions
        // require for a smooth join without a cusp (angle 0: parameter directions equal; pi: opposite)
        const sa = endSign(c.a, c.p1), sb = endSign(c.b, c.p2);
        const angle = sa * sb === -1 ? 0 : Math.PI;
        const ca = tangentCurve(c.a, c.p1, c), cb = tangentCurve(c.b, c.p2, c);
        return { cls: 'composed', defs: [
          { type: 'p2p_coincident', p1_id: c.p1, p2_id: c.p2, driving: true },
          { type: 'angle_via_point', crv1_id: ca, crv2_id: cb, p_id: c.p1, angle, driving: true },
        ] };
      }
      case 'equal': {
        const ta = el(c.a).type, tb = el(c.b).type;
        if (ta === 'line' && tb === 'line') return { cls: 'direct', defs: [{ type: 'equal_length', l1_id: c.a, l2_id: c.b, driving: true }] };
        return { cls: 'direct', defs: [equalRadiusPrim(c.a, c.b, true)] };
      }
      case 'parallel': return { cls: 'direct', defs: [{ type: 'parallel', l1_id: c.l1, l2_id: c.l2, driving: true }] };
      case 'perpendicular': return { cls: 'direct', defs: [{ type: 'perpendicular_ll', l1_id: c.l1, l2_id: c.l2, driving: true }] };
      case 'fix': return { cls: 'direct', defs: [
        { type: 'coordinate_x', p_id: c.point, x: st.x, driving: true },
        { type: 'coordinate_y', p_id: c.point, y: st.y, driving: true },
      ] };
      case 'midpoint': {
        if (c.line) { const l = el(c.line); return { cls: 'direct', defs: [{ type: 'p2p_symmetric_ppp', p1_id: l.p1, p2_id: l.p2, p_id: c.point, driving: true }] }; }
        const a = el(c.arc);
        return { cls: 'composed', defs: [
          { type: 'point_on_arc', p_id: c.point, a_id: c.arc, driving: true },
          { type: 'point_on_perp_bisector_ppp', p_id: c.point, lp1_id: a.start, lp2_id: a.end, driving: true },
        ] };
      }
      case 'concentric': return { cls: 'composed', defs: [{ type: 'p2p_coincident', p1_id: el(c.a).center, p2_id: el(c.b).center, driving: true }] };
      case 'collinear': {
        const l2 = el(c.l2);
        return { cls: 'composed', defs: [
          { type: 'point_on_line_pl', p_id: l2.p1, l_id: c.l1, driving: true },
          { type: 'point_on_line_pl', p_id: l2.p2, l_id: c.l1, driving: true },
        ] };
      }
      case 'symmetric':
        if (c.line) return { cls: 'direct', defs: [{ type: 'p2p_symmetric_ppl', p1_id: c.p1, p2_id: c.p2, l_id: c.line, driving: true }] };
        return { cls: 'direct', defs: [{ type: 'p2p_symmetric_ppp', p1_id: c.p1, p2_id: c.p2, p_id: c.center, driving: true }] };
      case 'curvature': {
        const ta = el(c.a).type, tb = el(c.b).type;
        if (isCircleLike(c.a) && isCircleLike(c.b)) {
          // two curves with a common tangent and equal curvature vectors lie on one circle: angle between the
          // package's circle normals (centre - point) is 0 and the radii are equal
          return { cls: 'composed', defs: [
            { type: 'p2p_coincident', p1_id: c.p1, p2_id: c.p2, driving: true },
            { type: 'angle_via_point', crv1_id: c.a, crv2_id: c.b, p_id: c.p1, angle: 0, driving: true },
            equalRadiusPrim(c.a, c.b, true),
          ] };
        }
        throw new Unsupported(`curvature (G2) between ${ta} and ${tb}: the package has no curvature constraint and its fixed binding list cannot be extended; only the composition on one circle exists for arcs/circles (no match for "curvature" in planegcs sources)`);
      }
      case 'tangent_at_knot': {
        const b = el(c.bspline);
        const kid = `${c.id}~knotpoint`;
        const pts = b.poles.map((pid) => [geom[pid].x, geom[pid].y]);
        const k0 = bsplineEval(b, pts, b.knots[c.knot], 0)[0]; // start value only; the alignment constraint moves it
        aux.push({ kind: 'prim', def: { id: kid, type: 'point', x: k0[0], y: k0[1], fixed: false } });
        owner.set(kid, null); internalLabel.set(kid, `knot point of ${c.bspline}`);
        const out = { cls: 'composed', defs: [
          { type: 'internal_alignment_knot_point', b_id: c.bspline, p_id: kid, knotindex: c.knot, driving: true },
          { type: 'point_on_line_pl', p_id: kid, l_id: c.line, driving: true },
          { type: 'tangent_at_bspline_knot', b_id: c.bspline, l_id: c.line, knotindex: c.knot, driving: true },
        ] };
        if (b.mult[c.knot] >= b.degree) out.kink = `knot multiplicity ${b.mult[c.knot]} >= degree ${b.degree}`;
        return out;
      }
      // dimensions
      case 'distance': return { cls: 'direct', defs: [{ type: 'p2p_distance', p1_id: c.p1, p2_id: c.p2, distance: v, driving: drv }] };
      case 'length': { const l = el(c.line); return { cls: 'direct', defs: [{ type: 'p2p_distance', p1_id: l.p1, p2_id: l.p2, distance: v, driving: drv }] }; }
      case 'distance_point_line': return { cls: 'direct', defs: [{ type: 'p2l_distance', p_id: c.point, l_id: c.line, distance: v, driving: drv }] };
      case 'distance_x': return { cls: 'direct', defs: [{ type: 'difference', param1: { o_id: c.p1, prop: 'x' }, param2: { o_id: c.p2, prop: 'x' }, difference: v, driving: drv }] };
      case 'distance_y': return { cls: 'direct', defs: [{ type: 'difference', param1: { o_id: c.p1, prop: 'y' }, param2: { o_id: c.p2, prop: 'y' }, difference: v, driving: drv }] };
      case 'angle': return { cls: 'direct', defs: [{ type: 'l2l_angle_ll', l1_id: c.l1, l2_id: c.l2, angle: v, driving: drv }] };
      case 'angle_line': { const l = el(c.line); return { cls: 'direct', defs: [{ type: 'p2p_angle', p1_id: l.p1, p2_id: l.p2, angle: v, driving: drv }] }; }
      case 'radius': return { cls: 'direct', defs: [el(c.curve).type === 'arc' ? { type: 'arc_radius', a_id: c.curve, radius: v, driving: drv } : { type: 'circle_radius', c_id: c.curve, radius: v, driving: drv }] };
      case 'diameter': return { cls: 'direct', defs: [el(c.curve).type === 'arc' ? { type: 'arc_diameter', a_id: c.curve, diameter: v, driving: drv } : { type: 'circle_diameter', c_id: c.curve, diameter: v, driving: drv }] };
      case 'arc_length': return { cls: 'direct', defs: [{ type: 'arc_length', a_id: c.arc, dist: v, driving: drv }] };
      default: throw new Unsupported(`constraint type ${c.type}`);
    }
  };

  const ops_params = [];     // sketch parameters (curve parameters), pushed before the constraints
  const consOps = [];
  const kinks = [];
  for (const [id, st] of state) {
    if (!st.enabled) continue;
    const c = { ...st.c };
    const r = defsOf(c, st);
    r.defs.forEach((d, i) => {
      const pid = i === 0 ? id : `${id}~${i + 1}`;
      d.id = pid;
      consOps.push({ kind: 'prim', def: d });
      owner.set(pid, id);
      if (!mapping.has(c.type)) mapping.set(c.type, new Set());
      mapping.get(c.type).add(d.type);
    });
    classOf.set(id, r.cls);
    if (r.kink) kinks.push(`${id}: ${r.kink}`);
    if (VALUE_PROP[c.type]) {
      const [t, prop] = VALUE_PROP[c.type];
      const prim = r.defs.find((d) => (t === null ? true : d.type === t));
      valueRef.set(id, { prim: prim.id, prop });
    }
  }
  // drag: temporary coordinate constraints (tag -1, solved in the package's second subsystem with SQP)
  const dragOps = [];
  if (drag) {
    dragOps.push({ kind: 'prim', def: { id: '~dragx', type: 'coordinate_x', p_id: drag.point, x: drag.x, driving: true, temporary: true } });
    dragOps.push({ kind: 'prim', def: { id: '~dragy', type: 'coordinate_y', p_id: drag.point, y: drag.y, driving: true, temporary: true } });
    owner.set('~dragx', null); owner.set('~dragy', null);
  }

  const mapText = [...mapping.entries()].map(([k, set]) => `${k}->${[...set].join('+')}`).join('; ');
  // hasAux: the plan has non-driving or temporary constraints, which the solver puts into a second subsystem (SQP)
  const hasAux = !!drag || [...state.values()].some((st) => st.enabled && !st.driving);
  return { ops: [...ops, ...aux, ...ops_params, ...consOps, ...dragOps], owner, classOf, mapText, valueRef, internalLabel, kinks, hasAux };
}

