// Typed-array views on the mesh buffers of a result payload (layout in protocol.ts, MeshLayout).
import type { BodyResult, BufferRef } from "./protocol.ts";

export interface BodyMeshViews {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceIds: Uint32Array;
  edgePositions: Float32Array;
  edgeIds: Uint32Array;
}

function f32(payload: ArrayBuffer, r: BufferRef): Float32Array {
  return new Float32Array(payload, r.offset, r.byteLength / 4);
}
function u32(payload: ArrayBuffer, r: BufferRef): Uint32Array {
  return new Uint32Array(payload, r.offset, r.byteLength / 4);
}

/** Zero-copy views; they stay valid as long as the payload ArrayBuffer is not transferred elsewhere. */
export function meshViews(payload: ArrayBuffer, body: BodyResult): BodyMeshViews {
  const m = body.mesh;
  return {
    positions: f32(payload, m.positions),
    normals: f32(payload, m.normals),
    indices: u32(payload, m.indices),
    faceIds: u32(payload, m.faceIds),
    edgePositions: f32(payload, m.edgePositions),
    edgeIds: u32(payload, m.edgeIds),
  };
}

/** Maps a picked triangle index to the face it belongs to. */
export function faceOfTriangle(views: BodyMeshViews, body: BodyResult, triangle: number) {
  const id = views.faceIds[triangle];
  return id === undefined ? undefined : body.faces[id];
}
