// Geometry measurements of a sketch with plain formulas, independent of planegcs. Used to measure reference
// dimensions after solving and to verify a solved sketch (residual of every constraint).
#pragma once

#include "sketch/sketch.hpp"

#include <map>
#include <string>

namespace hc::sketch {

// Current value of a dimension constraint (Distance, LineAngle, Radius, Diameter) in the given geometry.
// Throws SketchError for other constraint types or unknown references.
double measure(const Sketch& sketch, const Constraint& c);

struct ResidualReport {
    double maxResidual = 0.0;
    std::string worst;                          // id of the constraint (or "arc <id>") with the largest residual
    std::map<std::string, double> residuals;    // per driving constraint, plus "arc <id>" for the arc end points
};

// Residual of every driving constraint (mm, or rad for angles and directions) and of every arc's end points lying
// on its circle.
ResidualReport checkConstraints(const Sketch& sketch);

} // namespace hc::sketch
