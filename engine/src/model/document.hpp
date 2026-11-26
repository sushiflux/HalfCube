// Reading the stored document into the engine's own models: the plane frames of the origin planes, sketches as
// sketch::Sketch (lengths in mm, angles in rad) and the structural checks of a whole document. Every failure is an
// EngineError with code bad_document whose message names the path of the offending part.
#pragma once

#include "generated/protocol.hpp"
#include "sketch/sketch.hpp"

#include <string>

namespace pc::model {

struct Vec3d {
    double x = 0.0, y = 0.0, z = 0.0;
};

inline Vec3d operator+(Vec3d a, Vec3d b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline Vec3d operator*(Vec3d a, double s) { return {a.x * s, a.y * s, a.z * s}; }

// Placement of a sketch plane: sketch point (u, v) lies at origin + u * u + v * v; normal = u x v.
struct Frame {
    Vec3d origin, u, v, normal;

    Vec3d at(double pu, double pv) const { return origin + u * pu + v * pv; }
    // The same plane moved along its normal by distance mm.
    Frame offset(double distance) const { return {origin + normal * distance, u, v, normal}; }
};

// xy: u +X, v +Y, n +Z; xz: u +X, v +Z, n -Y; yz: u +Y, v +Z, n +X (fixed in the protocol).
Frame frameOf(const protocol::PlaneRef& plane);
protocol::PlaneFrame toProtocol(const Frame& f);

// The sketch in the solver's terms. path names the sketch in messages, e.g. "sketch" or "document.timeline[0].sketch".
// Throws EngineError(bad_document) for wrong units, unknown references or kinds that do not fit their references.
sketch::Sketch toSketch(const protocol::SketchData& data, const std::string& path);

// Structural checks of a whole document (format, unique ids, the bodies the extrusions create, references to
// earlier sketches). The sketches themselves are checked when they are read. Throws EngineError(bad_document).
void checkDocument(const protocol::PartcraftDocument& doc);

} // namespace pc::model
