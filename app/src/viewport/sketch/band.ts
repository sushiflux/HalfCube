// The inner band of a determined region: a strip of constant width along the inside of each loop of the region, with a clear
// inner edge ("narrow" look). The loops come from the engine: the outer loop counter-clockwise, holes
// clockwise, so the inside of the region is always on the left of the direction of travel. The strip is built in sketch
// coordinates from the width in mm, which the layer derives from the zoom, so it stays about six pixels wide on the screen.
// Pure functions, tested in Node.

/** Width of the band on the screen, CSS pixels ("narrow" look). */
export const BAND_WIDTH_PX = 6;
/** Largest miter length in widths: sharper corners are cut off instead of shooting out. */
const MITER_LIMIT = 3;

export interface BandMesh {
  /** u v per vertex: even vertices lie on the contour, odd ones are the inner edge. */
  positions: Float32Array;
  indices: Uint32Array;
}

/** Signed area of a loop (u, v pairs): positive for counter-clockwise. */
export function loopArea(loop: Float32Array): number {
  const n = loop.length / 2;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += loop[i * 2]! * loop[j * 2 + 1]! - loop[j * 2]! * loop[i * 2 + 1]!;
  }
  return a / 2;
}

export function loopPerimeter(loop: Float32Array): number {
  const n = loop.length / 2;
  let p = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    p += Math.hypot(loop[j * 2]! - loop[i * 2]!, loop[j * 2 + 1]! - loop[i * 2 + 1]!);
  }
  return p;
}

/**
 * The band of one loop. The width is cut down where the loop is too small for it (twice the area over the perimeter is the
 * radius of a circle: a band wider than that would run through the middle of the shape and come out again).
 */
export function bandOfLoop(loop: Float32Array, widthMm: number): BandMesh | null {
  // Repeated points would give zero-length edges without a direction.
  const pts: [number, number][] = [];
  for (let i = 0; i < loop.length; i += 2) {
    const p: [number, number] = [loop[i]!, loop[i + 1]!];
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) pts.push(p);
  }
  if (pts.length > 1) {
    const f = pts[0]!, l = pts[pts.length - 1]!;
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) <= 1e-9) pts.pop();
  }
  const n = pts.length;
  if (n < 3) return null;
  const flat = new Float32Array(n * 2);
  pts.forEach((p, i) => flat.set(p, i * 2));
  const perimeter = loopPerimeter(flat);
  const area = Math.abs(loopArea(flat));
  if (perimeter < 1e-12 || area < 1e-12) return null;
  const w = Math.min(widthMm, (2 * area) / perimeter);

  const edgeNormal = (i: number): [number, number] => {
    const a = pts[i]!, b = pts[(i + 1) % n]!;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    return [-dy / l, dx / l]; // the left of the direction of travel: the inside of the region
  };
  const positions = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const n0 = edgeNormal((i + n - 1) % n), n1 = edgeNormal(i);
    let mx = n0[0] + n1[0], my = n0[1] + n1[1];
    const ml = Math.hypot(mx, my);
    let scale = w;
    if (ml < 1e-9) {
      // A reversal of direction: no miter, just step along the normal.
      mx = n1[0]; my = n1[1];
    } else {
      mx /= ml; my /= ml;
      const cos = mx * n1[0] + my * n1[1];
      scale = Math.min(w / Math.max(cos, 1e-6), w * MITER_LIMIT);
    }
    const p = pts[i]!;
    positions[i * 4] = p[0];
    positions[i * 4 + 1] = p[1];
    positions[i * 4 + 2] = p[0] + mx * scale;
    positions[i * 4 + 3] = p[1] + my * scale;
  }
  const indices = new Uint32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const o = i * 2, no = j * 2;
    indices.set([o, no, o + 1, no, no + 1, o + 1], i * 6);
  }
  return { positions, indices };
}

/**
 * The outlines that get a band: every loop of every region whose curves are all fully determined, outer loop and holes each
 * on their own (per loop). A free hole has no band; a determined outer loop keeps its band around free holes.
 */
export function determinedLoops(profiles: readonly { loops: readonly Float32Array[]; loopsDetermined: readonly boolean[] }[]): Float32Array[] {
  return profiles.flatMap((p) => p.loops.filter((_, i) => p.loopsDetermined[i] === true));
}

/** All bands of the given loops as one mesh. */
export function bandOfLoops(loops: readonly Float32Array[], widthMm: number): BandMesh {
  const parts = loops.map((l) => bandOfLoop(l, widthMm)).filter((b): b is BandMesh => b !== null);
  let vertices = 0, indexCount = 0;
  for (const p of parts) { vertices += p.positions.length / 2; indexCount += p.indices.length; }
  const positions = new Float32Array(vertices * 2);
  const indices = new Uint32Array(indexCount);
  let vo = 0, io = 0;
  for (const p of parts) {
    positions.set(p.positions, vo * 2);
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i]! + vo;
    vo += p.positions.length / 2;
    io += p.indices.length;
  }
  return { positions, indices };
}

/** Even-odd containment of a point in the loops of one region (the outer loop and its holes). */
export function insideLoops(loops: readonly Float32Array[], u: number, v: number): boolean {
  let inside = false;
  for (const loop of loops) {
    const n = loop.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = loop[i * 2]!, yi = loop[i * 2 + 1]!, xj = loop[j * 2]!, yj = loop[j * 2 + 1]!;
      if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
