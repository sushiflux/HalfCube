// Solver self-test: a fixed, fully constrained sketch solved with planegcs DogLeg and verified with independent
// geometry checks and closed-form positions.
//
// Rectangle A B C D (A fixed at the origin, AB = 60 mm, BC = 40 mm, AB and CD horizontal, BC and DA vertical),
// an arc from C around M to E, tangent to CD, driving diameter 20 mm, and the line M -> E at the angle 0.
// Solution: B (60, 0), C (60, 40), D (0, 40), M (60, 50), E (70, 50), arc radius 10. Reference dimensions:
// distance A-E = sqrt(70^2 + 50^2) and the arc diameter 20 mm, both measured after solving.
#pragma once

#include "core/errors.hpp"
#include "generated/protocol.hpp"
#include "sketch/sketch.hpp"

#include <map>
#include <string>
#include <utility>

namespace pc::sketch {

// The self-test sketch at its (deliberately displaced) start geometry.
Sketch selftestSketch();

// Closed-form solution: point id -> (x, y), plus "arc" -> (radius, 0).
std::map<std::string, std::pair<double, double>> selftestSolution();

protocol::SolverSelftestResult runSelftest(const CancelCheck& cancelled);

} // namespace pc::sketch
