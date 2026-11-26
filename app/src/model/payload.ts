// Typed-array views on the binary payload of an engine answer (no copies; offsets are aligned by the engine).
import type { BodyResult, BufferRef, Region } from "../engine/generated/protocol.ts";
import type { BodyView, ProfileView } from "./editors.ts";

const EMPTY = new ArrayBuffer(0);

function check(payload: ArrayBuffer | null, ref: BufferRef, size: number, what: string): ArrayBuffer {
  const buffer = payload ?? EMPTY;
  if (ref.offset % size !== 0 || ref.byteLength % size !== 0 || ref.offset + ref.byteLength > buffer.byteLength) {
    throw new Error(
      `The engine answer refers to ${what} at bytes ${ref.offset}..${ref.offset + ref.byteLength}, but the payload has ` +
        `${buffer.byteLength} bytes or the range is not aligned to ${size} bytes.`,
    );
  }
  return buffer;
}

export const floats = (payload: ArrayBuffer | null, ref: BufferRef, what: string): Float32Array =>
  new Float32Array(check(payload, ref, 4, what), ref.offset, ref.byteLength / 4);

export const uints = (payload: ArrayBuffer | null, ref: BufferRef, what: string): Uint32Array =>
  new Uint32Array(check(payload, ref, 4, what), ref.offset, ref.byteLength / 4);

export function bodyView(b: BodyResult, payload: ArrayBuffer | null): BodyView {
  const what = (name: string) => `${name} of body ${b.bodyId}`;
  return {
    id: b.bodyId,
    featureId: b.featureId,
    meshKey: b.meshKey,
    preview: b.preview,
    volume: b.volume,
    area: b.area,
    bbox: b.bbox,
    faces: b.faces,
    edges: b.edges,
    mesh: {
      positions: floats(payload, b.mesh.positions, what("positions")),
      normals: floats(payload, b.mesh.normals, what("normals")),
      indices: uints(payload, b.mesh.indices, what("indices")),
      triangleFace: uints(payload, b.mesh.triangleFace, what("triangleFace")),
      edgePoints: floats(payload, b.mesh.edgePoints, what("edgePoints")),
    },
  };
}

/**
 * A loop is determined when every curve of it is fully determined. states: the element states of the same engine answer
 * (SketchSolveResult.entities); without them (the request had diagnose false) nothing is known and no loop is determined,
 * like Region.determined.
 */
export function loopsDetermined(r: Pick<Region, "outer" | "holes">, states: Readonly<Record<string, string>> | undefined): boolean[] {
  return [r.outer, ...r.holes].map((ids) => states !== undefined && ids.length > 0 && ids.every((id) => states[id] === "full"));
}

export function profileView(r: Region, payload: ArrayBuffer | null, states?: Readonly<Record<string, string>>): ProfileView {
  return {
    key: r.key,
    outer: r.outer,
    holes: r.holes,
    area: r.area,
    determined: r.determined,
    loopsDetermined: loopsDetermined(r, states),
    fill: {
      positions: floats(payload, r.fill.positions, `fill positions of region ${r.key}`),
      indices: uints(payload, r.fill.indices, `fill indices of region ${r.key}`),
    },
    loops: r.loops.map((ref, i) => floats(payload, ref, `outline ${i} of region ${r.key}`)),
  };
}
