// Kernel side of the slice: the planar face of a sketch region (built from our own vertices and edges, so the sketch
// id behind every edge and vertex is known without asking OCCT's wire history), its triangles for display, the
// extrusion with persistent names, the result checks, and the triangle mesh of a body.
#pragma once

#include "generated/protocol.hpp"
#include "kernel/shape_check.hpp"
#include "model/document.hpp"
#include "model/profiles.hpp"
#include "sketch/sketch.hpp"

#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Vertex.hxx>

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace hc::model {

struct ProfileFace {
    TopoDS_Face face;
    std::vector<std::pair<std::string, TopoDS_Edge>> edges;       // curve id -> edge, in loop order
    std::vector<std::pair<std::string, TopoDS_Vertex>> vertices;  // point group -> vertex (line loops)
    std::vector<std::pair<std::string, TopoDS_Vertex>> seams;     // circle id -> the vertex of its closed edge
};

// Builds the planar face of a region of the solved sketch on the plane frame. Throws EngineError(internal) when the
// kernel refuses to build it; check the face with kernel::inspectShape.
ProfileFace buildProfileFace(const RegionInfo& region, const sketch::Sketch& solved, const Frame& frame);

// Triangles of a region in sketch coordinates: (u, v) pairs and indices, counter-clockwise seen from the normal.
// loops: the outline of every loop (the outer loop first, then the holes in the order of region.holes) as (u, v)
// pairs, the first point not repeated at the end; outer loops counter-clockwise, holes clockwise. Circles are cut by
// the same mesher as the fill, so their points are corner points of the triangles.
struct RegionTriangles {
    std::vector<float> uv;
    std::vector<std::uint32_t> indices;
    std::vector<std::vector<float>> loops;
};
RegionTriangles triangulateRegion(const RegionInfo& region, const sketch::Sketch& solved);

// One named sub-shape of a body. Names: <step>:<role>[:<origin>], e.g. f12:side:l7, f12:start, f12:lateral:p3.
struct Named {
    std::string name;
    TopoDS_Shape shape;
};

// Which step made which named parts, and how. The slice only has extrusions, which generate everything from the
// sketch; changing steps (join, fillet) add "modified" and "deleted" entries and are chained by us, never with
// BRepTools_History::Merge.
struct OpHistory {
    struct Entry {
        std::string input;    // sketch curve, point group or the profile ("profile")
        std::string relation; // generated, modified or deleted
        std::vector<std::string> outputs;
    };
    std::string step;
    std::vector<Entry> entries;
};

struct BodyShape {
    TopoDS_Shape shape;
    std::vector<Named> faces, edges, vertices;
    OpHistory history;
};

struct ExtrudeParams {
    std::string featureId;
    std::string extent;  // oneSide or symmetric
    double distance = 0.0;  // mm; oneSide: sign = direction along the normal; symmetric: total thickness
};

struct ExtrudeOutcome {
    std::optional<BodyShape> body;  // missing when the step failed
    std::optional<protocol::Problem> problem;
    std::optional<protocol::StepCheck> check;
};

// Extrudes one region and checks the result: BRepCheck_Analyzer on the profile face and on the solid, solid count 1,
// volume = region area x thickness (relative 1e-6), faces = curves of all loops + 2, and every face, edge and vertex
// carrying exactly one name.
ExtrudeOutcome extrudeRegion(const RegionInfo& region, const sketch::Sketch& solved, const Frame& frame, const ExtrudeParams& p);

// Triangle mesh of a body: buffers in `block` with offsets relative to the block start.
struct MeshedBody {
    protocol::BodyResult info;
    std::vector<std::uint8_t> block;
    double meshMs = 0.0;
    double encodeMs = 0.0;
};
MeshedBody meshBody(const BodyShape& body, const std::string& bodyId, const std::string& featureId, const std::string& meshKey);

// Chord deviation (mm) and angle (deg) of every triangulation, as in the kernel test.
inline constexpr double kMeshDeflection = 0.05;
inline constexpr double kMeshAngleDeg = 20.0;

} // namespace hc::model
