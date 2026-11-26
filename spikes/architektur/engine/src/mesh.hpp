// Tessellation of a body and its binary encoding (layout: protocol.ts, MeshLayout).
#pragma once

#include "json.hpp"
#include "model.hpp"

#include <cstdint>
#include <vector>

namespace hc {

struct MeshParams {
    double deflection = 0.05;  // chordal deflection, mm
    double angleDeg = 20.0;    // angular deflection, degrees
};

// One body's mesh as a self-contained block: `info` is the BodyResult JSON with buffer offsets relative to the
// start of `bytes`; `bytes` has a size that is a multiple of the payload alignment.
struct MeshBlock {
    Json info;
    std::vector<uint8_t> bytes;
    double meshMs = 0;
    double encodeMs = 0;
};

// Tessellates (BRepMesh_IncrementalMesh) and encodes the body. Throws Cancelled when cancelled during meshing.
MeshBlock meshBody(const BodyOut& body, const MeshParams& p, const Model::CancelFn& cancelled);

// Appends a block to a payload at an aligned offset and returns the body JSON with absolute offsets.
Json appendBlock(const MeshBlock& block, std::vector<uint8_t>& payload);

} // namespace hc
