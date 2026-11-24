// Geometry and constraint evaluators of the independent checker.
// Plain ES module, no dependencies, no solver code. Everything here recomputes conditions from
// solved coordinates only. Units: mm and radians.

export const TWO_PI = 2 * Math.PI;

export function wrapPi(a) {
  // wraps into (-pi, pi]
  let r = a % TWO_PI;
  if (r > Math.PI) r -= TWO_PI;
  if (r <= -Math.PI) r += TWO_PI;
  return r;
}
export function wrap2Pi(a) {
  let r = a % TWO_PI;
  if (r < 0) r += TWO_PI;
  return r;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => { const l = len(a); return l === 0 ? [0, 0] : [a[0] / l, a[1] / l]; };
const rot90 = (a) => [-a[1], a[0]];
export const V = { sub, add, mul, dot, cross, len, unit, rot90 };

// ---------------------------------------------------------------------------------------------
// Case context: element lookup + solved geometry
// ---------------------------------------------------------------------------------------------

export class Ctx {
  constructor(caseDef, geometry) {
    this.elements = new Map();
    for (const e of caseDef.elements) this.elements.set(e.id, e);
    this.G = geometry || {};
  }
  el(id) {
    const e = this.elements.get(id);
    if (!e) throw new Error(`unknown element '${id}'`);
    return e;
  }
  P(id) {
    const e = this.el(id);
    if (e.type !== 'point') throw new Error(`element '${id}' is a ${e.type}, point expected`);
    const g = this.G[id];
    if (!g || typeof g.x !== 'number' || typeof g.y !== 'number') throw new Error(`no solved coordinates for point '${id}'`);
    return [g.x, g.y];
  }
  // end points of a line, in the order p1 -> p2
  line(id) {
    const e = this.el(id);
    if (e.type !== 'line') throw new Error(`element '${id}' is a ${e.type}, line expected`);
    return [this.P(e.p1), this.P(e.p2)];
  }
  isCurveWithCenter(id) { const t = this.el(id).type; return t === 'circle' || t === 'arc'; }
  center(id) { return this.P(this.el(id).center); }
  radius(id) {
    const g = this.G[id];
    if (!g || typeof g.radius !== 'number') throw new Error(`no solved radius for '${id}'`);
    return g.radius;
  }
  arc(id) {
    const e = this.el(id);
    if (e.type !== 'arc') throw new Error(`element '${id}' is a ${e.type}, arc expected`);
    return { c: this.P(e.center), s: this.P(e.start), e: this.P(e.end), r: this.radius(id) };
  }
  bspline(id) {
    const e = this.el(id);
    if (e.type !== 'bspline') throw new Error(`element '${id}' is a ${e.type}, bspline expected`);
    return { spec: e, poles: e.poles.map((p) => this.P(p)) };
  }
}

// ---------------------------------------------------------------------------------------------
// Basic curve helpers
// ---------------------------------------------------------------------------------------------

export function distPointLine(p, a, b) {
  const d = sub(b, a);
  const l = len(d);
  if (l === 0) return len(sub(p, a));
  return Math.abs(cross(d, sub(p, a))) / l;
}

// ccw sweep angle of an arc from its start to its end point, in (0, 2pi]
export function arcSweep(c, s, e) {
  const d = wrap2Pi(Math.atan2(e[1] - c[1], e[0] - c[0]) - Math.atan2(s[1] - c[1], s[0] - c[0]));
  return d === 0 ? TWO_PI : d;
}

export function onArcSpan(c, s, e, p) {
  const sw = arcSweep(c, s, e);
  const a = wrap2Pi(Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(s[1] - c[1], s[0] - c[0]));
  return a <= sw + 1e-12;
}

// ---------------------------------------------------------------------------------------------
// B-splines: same knot conventions as planegcs (distinct knots + multiplicities, periodic padding as
// in GCS::BSpline::setupFlattenedKnots, Geo.cpp:1109), evaluation by the NURBS-book algorithms.
// ---------------------------------------------------------------------------------------------

export function flattenKnots(spec) {
  const { knots, mult, degree, periodic } = spec;
  let flat = [];
  for (let i = 0; i < knots.length; i++) for (let j = 0; j < mult[i]; j++) flat.push(knots[i]);
  if (periodic) {
    const period = knots[knots.length - 1] - knots[0];
    const c = degree + 1 - mult[0];
    const n = flat.length;
    const front = flat.slice(n - mult[mult.length - 1] - c, n - mult[mult.length - 1]);
    const back = flat.slice(mult[0], mult[0] + c);
    flat = [...front, ...flat, ...back];
    for (let i = 0; i < c; i++) {
      flat[i] -= period;
      flat[flat.length - 1 - i] += period;
    }
  }
  return flat;
}

export function bsplineDomain(spec) {
  return [spec.knots[0], spec.knots[spec.knots.length - 1]];
}

function findSpan(U, p, u) {
  // span index k in [p, U.length-p-2] with U[k] <= u < U[k+1]; the last span is closed at the right end
  const hi = U.length - p - 2;
  for (let i = p; i <= hi; i++) if (U[i] <= u && u < U[i + 1]) return i;
  return hi;
}

// basis functions and their derivatives up to order nd (NURBS book A2.3)
function dersBasis(U, k, u, p, nd) {
  const ndu = Array.from({ length: p + 1 }, () => new Array(p + 1).fill(0));
  const left = new Array(p + 1).fill(0);
  const right = new Array(p + 1).fill(0);
  ndu[0][0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[k + 1 - j];
    right[j] = U[k + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const temp = ndu[r][j - 1] / ndu[j][r];
      ndu[r][j] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j][j] = saved;
  }
  const ders = Array.from({ length: nd + 1 }, () => new Array(p + 1).fill(0));
  for (let j = 0; j <= p; j++) ders[0][j] = ndu[j][p];
  const a = [new Array(p + 1).fill(0), new Array(p + 1).fill(0)];
  for (let r = 0; r <= p; r++) {
    let s1 = 0, s2 = 1;
    a[0][0] = 1;
    for (let kk = 1; kk <= nd; kk++) {
      let d = 0;
      const rk = r - kk, pk = p - kk;
      if (r >= kk) {
        a[s2][0] = a[s1][0] / ndu[pk + 1][rk];
        d = a[s2][0] * ndu[rk][pk];
      }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? kk - 1 : p - r;
      for (let j = j1; j <= j2; j++) {
        a[s2][j] = (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][rk + j];
        d += a[s2][j] * ndu[rk + j][pk];
      }
      if (r <= pk) {
        a[s2][kk] = -a[s1][kk - 1] / ndu[pk + 1][r];
        d += a[s2][kk] * ndu[r][pk];
      }
      ders[kk][r] = d;
      const t = s1; s1 = s2; s2 = t;
    }
  }
  let r = p;
  for (let kk = 1; kk <= nd; kk++) {
    for (let j = 0; j <= p; j++) ders[kk][j] *= r;
    r *= p - kk;
  }
  return ders;
}

// returns [C, C', C''] (each [x,y]) of the rational curve at parameter u
export function bsplineEval(spec, poles, u, nd = 2) {
  const p = spec.degree;
  const U = flattenKnots(spec);
  const n = poles.length;
  const [u0, u1] = bsplineDomain(spec);
  const uu = Math.min(Math.max(u, u0), u1);
  const k = findSpan(U, p, uu);
  const ders = dersBasis(U, k, uu, p, Math.min(nd, p));
  const Aw = []; // homogeneous derivatives (x*w, y*w, w)
  for (let d = 0; d <= nd; d++) {
    let x = 0, y = 0, w = 0;
    if (d <= p) {
      for (let j = 0; j <= p; j++) {
        const idx = (k - p + j) % n;
        const wt = spec.weights[idx];
        const b = ders[d][j];
        x += b * wt * poles[idx][0];
        y += b * wt * poles[idx][1];
        w += b * wt;
      }
    }
    Aw.push([x, y, w]);
  }
  // rational derivatives (NURBS book A4.2)
  const C = [];
  for (let d = 0; d <= nd; d++) {
    let vx = Aw[d][0], vy = Aw[d][1];
    for (let i = 1; i <= d; i++) {
      const bin = binom(d, i);
      vx -= bin * Aw[i][2] * C[d - i][0];
      vy -= bin * Aw[i][2] * C[d - i][1];
    }
    C.push([vx / Aw[0][2], vy / Aw[0][2]]);
  }
  return C;
}

function binom(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

// minimal distance of a point to the spline curve (coarse sampling + local golden-section refinement)
export function bsplineClosest(spec, poles, pt) {
  const [u0, u1] = bsplineDomain(spec);
  const N = 600;
  let best = { u: u0, d: Infinity };
  for (let i = 0; i <= N; i++) {
    const u = u0 + ((u1 - u0) * i) / N;
    const d = len(sub(bsplineEval(spec, poles, u, 0)[0], pt));
    if (d < best.d) best = { u, d };
  }
  let a = Math.max(u0, best.u - (u1 - u0) / N), b = Math.min(u1, best.u + (u1 - u0) / N);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 80; it++) {
    const c = b - g * (b - a), d = a + g * (b - a);
    const fc = len(sub(bsplineEval(spec, poles, c, 0)[0], pt));
    const fd = len(sub(bsplineEval(spec, poles, d, 0)[0], pt));
    if (fc < fd) b = d; else a = c;
  }
  const u = (a + b) / 2;
  const d = len(sub(bsplineEval(spec, poles, u, 0)[0], pt));
  return d < best.d ? { u, d } : best;
}

// ---------------------------------------------------------------------------------------------
// Tangent and curvature vectors at a junction point
// ---------------------------------------------------------------------------------------------

// Parameter of a spline end that sits at point id `pid` (first or last pole), or null.
function bsplineEndOf(ctx, id, pid) {
  const e = ctx.el(id);
  if (e.poles[0] === pid) return 'start';
  if (e.poles[e.poles.length - 1] === pid) return 'end';
  return null;
}

// Unit tangent of a curve at the junction point `pid` (a point belonging to the curve), direction
// pointing INTO the curve (away from the junction). Throws if not available.
export function interiorTangent(ctx, id, pid) {
  const e = ctx.el(id);
  const p = ctx.P(pid);
  if (e.type === 'line') {
    const [a, b] = ctx.line(id);
    if (e.p1 === pid) return unit(sub(b, a));
    if (e.p2 === pid) return unit(sub(a, b));
    throw new Error(`point '${pid}' is not an end point of line '${id}'`);
  }
  if (e.type === 'arc') {
    const a = ctx.arc(id);
    const t = unit(rot90(sub(p, a.c))); // ccw tangent at p
    if (e.start === pid) return t;
    if (e.end === pid) return mul(t, -1);
    throw new Error(`point '${pid}' is not an end point of arc '${id}'`);
  }
  if (e.type === 'circle') {
    // no interior direction; return the ccw tangent
    return unit(rot90(sub(p, ctx.center(id))));
  }
  if (e.type === 'bspline') {
    const { spec, poles } = ctx.bspline(id);
    const end = bsplineEndOf(ctx, id, pid);
    if (!end) throw new Error(`point '${pid}' is not an end pole of bspline '${id}'`);
    const [u0, u1] = bsplineDomain(spec);
    const C = bsplineEval(spec, poles, end === 'start' ? u0 : u1, 1);
    const t = unit(C[1]);
    return end === 'start' ? t : mul(t, -1);
  }
  throw new Error(`tangent at a ${e.type} is not implemented`);
}

// Curvature vector (points to the centre of curvature, length = |kappa|) at the junction point.
export function curvatureVector(ctx, id, pid) {
  const e = ctx.el(id);
  if (e.type === 'line') return [0, 0];
  if (e.type === 'arc' || e.type === 'circle') {
    const c = ctx.center(id);
    const r = ctx.radius(id);
    return mul(sub(c, ctx.P(pid)), 1 / (r * r));
  }
  if (e.type === 'bspline') {
    const { spec, poles } = ctx.bspline(id);
    const end = bsplineEndOf(ctx, id, pid);
    if (!end) throw new Error(`point '${pid}' is not an end pole of bspline '${id}'`);
    const [u0, u1] = bsplineDomain(spec);
    const C = bsplineEval(spec, poles, end === 'start' ? u0 : u1, 2);
    const sp = len(C[1]);
    if (sp === 0) throw new Error('zero speed at spline end');
    const t = mul(C[1], 1 / sp);
    const acc = sub(C[2], mul(t, dot(C[2], t)));
    return mul(acc, 1 / (sp * sp));
  }
  throw new Error(`curvature of a ${e.type} is not implemented`);
}

// ---------------------------------------------------------------------------------------------
// Dimension measurement (value of a dimension computed from coordinates)
// ---------------------------------------------------------------------------------------------

export const DIMENSION_TYPES = new Set([
  'distance', 'distance_point_line', 'distance_x', 'distance_y', 'length', 'angle', 'angle_line',
  'radius', 'diameter', 'arc_length',
]);

export function isAngular(type) { return type === 'angle' || type === 'angle_line'; }

export function measure(ctx, c) {
  switch (c.type) {
    case 'distance': return len(sub(ctx.P(c.p2), ctx.P(c.p1)));
    case 'distance_point_line': { const [a, b] = ctx.line(c.line); return distPointLine(ctx.P(c.point), a, b); }
    case 'distance_x': return ctx.P(c.p2)[0] - ctx.P(c.p1)[0];
    case 'distance_y': return ctx.P(c.p2)[1] - ctx.P(c.p1)[1];
    case 'length': { const [a, b] = ctx.line(c.line); return len(sub(b, a)); }
    case 'angle': {
      const [a1, b1] = ctx.line(c.l1);
      const [a2, b2] = ctx.line(c.l2);
      return wrapPi(Math.atan2(...sub(b2, a2).reverse()) - Math.atan2(...sub(b1, a1).reverse()));
    }
    case 'angle_line': { const [a, b] = ctx.line(c.line); return wrapPi(Math.atan2(b[1] - a[1], b[0] - a[0])); }
    case 'radius': return ctx.radius(c.curve);
    case 'diameter': return 2 * ctx.radius(c.curve);
    case 'arc_length': { const a = ctx.arc(c.arc); return a.r * arcSweep(a.c, a.s, a.e); }
    default: throw new Error(`'${c.type}' is not a dimension`);
  }
}

// ---------------------------------------------------------------------------------------------
// Constraint residuals. Each returns a list of { name, value, unit } where unit is 'len' | 'ang' |
// 'curv'; a constraint holds when |value| <= tolerance of its unit.
// ---------------------------------------------------------------------------------------------

const angleBetweenLines = (d1, d2) => {
  // angle between two undirected lines, in [0, pi/2]
  const th = Math.atan2(Math.abs(cross(d1, d2)), Math.abs(dot(d1, d2)));
  return th;
};

export function residuals(ctx, c, valueOverride) {
  const val = valueOverride !== undefined ? valueOverride : c.value;
  const out = [];
  const R = (name, value, unit) => out.push({ name, value, unit });
  switch (c.type) {
    case 'horizontal': {
      const [a, b] = c.line ? ctx.line(c.line) : [ctx.P(c.p1), ctx.P(c.p2)];
      R('dy', a[1] - b[1], 'len');
      break;
    }
    case 'vertical': {
      const [a, b] = c.line ? ctx.line(c.line) : [ctx.P(c.p1), ctx.P(c.p2)];
      R('dx', a[0] - b[0], 'len');
      break;
    }
    case 'coincident': R('dist', len(sub(ctx.P(c.p1), ctx.P(c.p2))), 'len'); break;
    case 'point_on_curve': R('offset', pointOnCurveOffset(ctx, c.point, c.curve), 'len'); break;
    case 'tangent': R('tangency', tangentOffset(ctx, c.a, c.b), 'len'); break;
    case 'tangent_at': {
      R('join', len(sub(ctx.P(c.p1), ctx.P(c.p2))), 'len');
      const t1 = interiorTangent(ctx, c.a, c.p1);
      const t2 = interiorTangent(ctx, c.b, c.p2);
      R('tangent_dir', Math.atan2(Math.abs(cross(t1, t2)), Math.abs(dot(t1, t2))), 'ang');
      break;
    }
    case 'equal': R('difference', equalDiff(ctx, c.a, c.b), 'len'); break;
    case 'parallel': {
      const [a1, b1] = ctx.line(c.l1), [a2, b2] = ctx.line(c.l2);
      R('angle', angleBetweenLines(sub(b1, a1), sub(b2, a2)), 'ang');
      break;
    }
    case 'perpendicular': {
      const [a1, b1] = ctx.line(c.l1), [a2, b2] = ctx.line(c.l2);
      R('angle', Math.PI / 2 - angleBetweenLines(sub(b1, a1), sub(b2, a2)), 'ang');
      break;
    }
    case 'fix': {
      const p = ctx.P(c.point);
      R('dx', p[0] - c.x, 'len');
      R('dy', p[1] - c.y, 'len');
      break;
    }
    case 'midpoint': {
      if (c.line) {
        const [a, b] = ctx.line(c.line);
        const m = mul(add(a, b), 0.5);
        const p = ctx.P(c.point);
        R('dx', p[0] - m[0], 'len');
        R('dy', p[1] - m[1], 'len');
      } else {
        // midpoint of an arc: on the circle, equidistant from both end points, on the arc span
        const a = ctx.arc(c.arc);
        const p = ctx.P(c.point);
        R('on_circle', len(sub(p, a.c)) - a.r, 'len');
        R('equidistant', len(sub(p, a.s)) - len(sub(p, a.e)), 'len');
        R('on_span', onArcSpan(a.c, a.s, a.e, p) ? 0 : 1, 'len');
      }
      break;
    }
    case 'concentric': R('centers', len(sub(ctx.center(c.a), ctx.center(c.b))), 'len'); break;
    case 'collinear': {
      const [a, b] = ctx.line(c.l1);
      const [p, q] = ctx.line(c.l2);
      R('p', distPointLine(p, a, b), 'len');
      R('q', distPointLine(q, a, b), 'len');
      break;
    }
    case 'symmetric': {
      const p1 = ctx.P(c.p1), p2 = ctx.P(c.p2);
      if (c.line) {
        const [a, b] = ctx.line(c.line);
        const mid = mul(add(p1, p2), 0.5);
        R('mid_on_axis', distPointLine(mid, a, b), 'len');
        const d = sub(p2, p1);
        const axis = sub(b, a);
        // p1p2 must be perpendicular to the axis (a coincident pair is symmetric by itself)
        R('perp', len(d) === 0 ? 0 : (Math.PI / 2 - angleBetweenLines(d, axis)), 'ang');
      } else {
        const cc = ctx.P(c.center);
        R('sum_x', p1[0] + p2[0] - 2 * cc[0], 'len');
        R('sum_y', p1[1] + p2[1] - 2 * cc[1], 'len');
      }
      break;
    }
    case 'curvature': {
      // G2 junction: coincident + parallel tangents + equal curvature vectors
      R('join', len(sub(ctx.P(c.p1), ctx.P(c.p2))), 'len');
      const t1 = interiorTangent(ctx, c.a, c.p1), t2 = interiorTangent(ctx, c.b, c.p2);
      R('tangent_dir', Math.atan2(Math.abs(cross(t1, t2)), Math.abs(dot(t1, t2))), 'ang');
      R('curvature', len(sub(curvatureVector(ctx, c.a, c.p1), curvatureVector(ctx, c.b, c.p2))), 'curv');
      break;
    }
    case 'tangent_at_knot': {
      const { spec, poles } = ctx.bspline(c.bspline);
      const u = spec.knots[c.knot];
      const [a, b] = ctx.line(c.line);
      const dirLine = sub(b, a);
      // one-sided tangents (matter when the knot has multiplicity >= degree)
      const eps = 1e-9 * (spec.knots[spec.knots.length - 1] - spec.knots[0]);
      const C = bsplineEval(spec, poles, u, 1);
      R('on_line', distPointLine(C[0], a, b), 'len');
      const uL = Math.max(spec.knots[0], u - eps), uR = Math.min(spec.knots[spec.knots.length - 1], u + eps);
      const sides = [];
      if (uL < u) sides.push(bsplineEval(spec, poles, uL, 1)[1]);
      if (uR > u) sides.push(bsplineEval(spec, poles, uR, 1)[1]);
      sides.forEach((tv, i) => R(i === 0 && sides.length === 2 ? 'slope_left' : (sides.length === 2 ? 'slope_right' : 'slope'),
        Math.atan2(Math.abs(cross(unit(tv), unit(dirLine))), Math.abs(dot(unit(tv), unit(dirLine)))), 'ang'));
      break;
    }
    case 'no_cusp': {
      // the two curves must continue in opposite directions away from the junction (smooth join, no cusp)
      const t1 = interiorTangent(ctx, c.a, c.p1), t2 = interiorTangent(ctx, c.b, c.p2);
      R('cusp', Math.max(0, dot(t1, t2)), 'ang');
      break;
    }
    default:
      if (DIMENSION_TYPES.has(c.type)) {
        const m = measure(ctx, c);
        if (isAngular(c.type)) R('error', wrapPi(m - val), 'ang');
        else R('error', m - val, 'len');
        break;
      }
      throw new Error(`unknown constraint type '${c.type}'`);
  }
  return out;
}

function pointOnCurveOffset(ctx, pid, cid) {
  const e = ctx.el(cid);
  const p = ctx.P(pid);
  if (e.type === 'line') { const [a, b] = ctx.line(cid); return distPointLine(p, a, b); }
  if (e.type === 'circle' || e.type === 'arc') return len(sub(p, ctx.center(cid))) - ctx.radius(cid);
  if (e.type === 'bspline') { const { spec, poles } = ctx.bspline(cid); return bsplineClosest(spec, poles, p).d; }
  throw new Error(`point_on_curve with a ${e.type} is not implemented`);
}

function tangentOffset(ctx, aId, bId) {
  const a = ctx.el(aId), b = ctx.el(bId);
  const isLine = (e) => e.type === 'line';
  if (isLine(a) || isLine(b)) {
    const [l, cc] = isLine(a) ? [aId, bId] : [bId, aId];
    const [p, q] = ctx.line(l);
    return distPointLine(ctx.center(cc), p, q) - ctx.radius(cc);
  }
  if (ctx.isCurveWithCenter(aId) && ctx.isCurveWithCenter(bId)) {
    const d = len(sub(ctx.center(aId), ctx.center(bId)));
    const r1 = ctx.radius(aId), r2 = ctx.radius(bId);
    const ext = d - (r1 + r2);
    const int = d - Math.abs(r1 - r2);
    return Math.abs(ext) < Math.abs(int) ? ext : int;
  }
  throw new Error(`tangent between ${a.type} and ${b.type} is not implemented`);
}

function equalDiff(ctx, aId, bId) {
  const a = ctx.el(aId), b = ctx.el(bId);
  if (a.type === 'line' && b.type === 'line') {
    const [p, q] = ctx.line(aId), [r, s] = ctx.line(bId);
    return len(sub(q, p)) - len(sub(s, r));
  }
  if (ctx.isCurveWithCenter(aId) && ctx.isCurveWithCenter(bId)) return ctx.radius(aId) - ctx.radius(bId);
  throw new Error(`equal between ${a.type} and ${b.type} is not implemented`);
}

// signed area (2x) of a polygon given as point ids; the sign tells the orientation
export function signedArea2(ctx, ids) {
  const pts = ids.map((i) => ctx.P(i));
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - a[1] * b[0];
  }
  return s;
}
