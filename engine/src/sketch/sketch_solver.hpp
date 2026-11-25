// Sketch solver: maps a Sketch onto planegcs (FreeCAD's 2D constraint solver) and solves it with DogLeg.
//
// Rules this wrapper keeps:
// - All solver parameters live in one contiguous block in a fixed order (points x, y in sketch order; circle radii;
//   arc radius, start and end angle; then the driving dimension values in constraint order). planegcs orders the
//   unknowns of a subsystem by memory address, so scattered parameters make the result of an under-determined
//   sketch depend on the heap layout; with one block the result is reproducible.
// - Reference dimensions (driving = false) are never given to planegcs: it solves them in a second subsystem that
//   can still move free geometry. They are measured from the solved geometry instead.
// - A diameter is reported as twice the radius (as FreeCAD does). planegcs models a diameter as "radius = 0.5 x
//   value" and its equality reduction ignores the 0.5 when both sides are unknown; driving diameter values are
//   therefore always constants here, never unknowns.
// - Line angles use the 6-argument addConstraintP2PAngle; the 5-argument overload drops the tag, so a conflict on
//   the angle could not be named.
#pragma once

#include "sketch/sketch.hpp"

#include <cstddef>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace pc::sketch {

enum class SolveStatus {
    Solved,       // planegcs reached a solution with zero error (GCS::Success)
    Failed,       // no solution found; geometry unchanged
    Conflicting,  // contradicting constraints; not solved, geometry unchanged
    Redundant,    // constraints that repeat others; not solved, geometry unchanged
};

const char* nameOf(SolveStatus s);

struct SolveResult {
    SolveStatus status = SolveStatus::Failed;
    int dof = 0;  // remaining degrees of freedom (diagnosed at the solved geometry when solved)
    std::vector<std::string> conflicting;
    std::vector<std::string> redundant;
    std::vector<std::string> partiallyRedundant;
    Sketch geometry;                          // solved geometry; the input geometry when not solved
    std::map<std::string, double> reference;  // reference dimensions by constraint id, measured after solving
    std::size_t parameterCount = 0;           // size of the contiguous parameter block
    std::size_t solverConstraintCount = 0;    // driving constraints given to planegcs (without arc rules)
    double timeMs = 0.0;
};

// Thrown for a sketch that cannot be mapped (unknown or duplicate ids, wrong element kinds, bad values).
class SketchError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

SolveResult solve(const Sketch& sketch);

// Versions of the solver's header libraries, for hello.
std::string eigenVersion();
std::string boostVersion();

} // namespace pc::sketch
