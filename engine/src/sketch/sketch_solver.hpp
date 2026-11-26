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
// - The fixed references (@origin, @axisU, @axisV) are constants at the start of the block, created only when a
//   constraint refers to them. Fix is two coordinate constraints per point (plus the radius of a circle) with the
//   constraint's tag, so a conflict can name the fixing.
// - Every constraint is an equation of the same rank, solved together with all others; none has a direction.
// - Dragging (SolveOptions::drag) follows FreeCAD's Sketch::initMove: every dragged point gets a temporary coincident
//   constraint to a constant target point, tagged GCS::DefaultTemporaryConstraint (-1). planegcs keeps these out of the
//   diagnosis and solves them in a second subsystem with SQP, after the real constraints (tag >= 0), which therefore
//   always hold; a point that cannot reach its target ends as near as they allow. The target parameters are the last
//   ones of the parameter block, so the order of all others does not depend on the drag.
#pragma once

#include "sketch/sketch.hpp"

#include <cstddef>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace hc::sketch {

enum class SolveStatus {
    Solved,       // planegcs reached a solution with zero error (GCS::Success)
    Failed,       // no solution found; geometry unchanged
    Conflicting,  // contradicting constraints; not solved, geometry unchanged
    Redundant,    // constraints that repeat others; not solved, geometry unchanged
};

const char* nameOf(SolveStatus s);

// State of a point, line or circle after the diagnosis.
enum class EntityState {
    Under,  // can still move
    Full,   // fully determined
    Over,   // a conflicting constraint refers to it
};

const char* nameOf(EntityState s);

// A point and where the pointer wants it (sketch coordinates, mm).
struct DragTarget {
    std::string point;
    double x = 0.0;
    double y = 0.0;
};

struct SolveOptions {
    // Diagnose the solved geometry again for the degrees of freedom and the element states. With drag the states come
    // from the diagnosis planegcs makes anyway, at the geometry of the request (no second system).
    bool diagnose = true;
    // Drag step: the points to pull and their targets. Empty: a normal solve.
    std::vector<DragTarget> drag;
    // A drag whose targets are further away than this (mm) from the points is cut into steps of at most this length:
    // the solver test saw a first jump of 20 mm fail, short steps pass.
    // Every step costs one SQP run (about 3.5 ms for a chain of 40 links), so the number of steps is capped
    // (maxDragSteps): a longer way gets longer steps and the answer reports how near the points came.
    double maxDragStepMm = 10.0;
    int maxDragSteps = 40;
};

// What a drag step did with each dragged point.
struct DragPointOutcome {
    std::string point;
    double error = 0.0;  // mm between the solved position and the target
    bool moved = false;  // the point left the position it had in the request
};

struct DragOutcome {
    std::vector<DragPointOutcome> points;
    int steps = 0;          // solver runs that succeeded (each of at most maxDragStepMm)
    bool complete = true;   // false: a step found no solution and the geometry is the last good step
};

struct SolveResult {
    SolveStatus status = SolveStatus::Failed;
    int dof = 0;  // remaining degrees of freedom (diagnosed at the solved geometry when solved)
    std::vector<std::string> conflicting;
    std::vector<std::string> redundant;
    std::vector<std::string> partiallyRedundant;
    Sketch geometry;                          // solved geometry; the input geometry when not solved
    std::map<std::string, double> reference;  // reference dimensions by constraint id, measured after solving (mm, rad)
    bool diagnosed = false;                   // freePoints and freeRadii are valid
    std::set<std::string> freePoints;         // points with a coordinate that can still move
    std::set<std::string> freeRadii;          // circles whose radius can still change
    std::size_t parameterCount = 0;           // size of the contiguous parameter block
    std::size_t solverConstraintCount = 0;    // driving constraints given to planegcs (without arc rules)
    std::optional<DragOutcome> drag;          // set when the options had drag targets
    double timeMs = 0.0;
};

// Thrown for a sketch that cannot be mapped (unknown or duplicate ids, wrong element kinds, bad values).
class SketchError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

SolveResult solve(const Sketch& sketch, const SolveOptions& options = {});

// State of every point, line and circle: over when a conflicting constraint refers to it, otherwise full when
// nothing of it can move (a line: both end points; a circle: centre and radius), otherwise under.
// Requires a diagnosed result.
std::map<std::string, EntityState> entityStates(const Sketch& sketch, const SolveResult& result);

// Versions of the solver's header libraries, for hello.
std::string eigenVersion();
std::string boostVersion();

} // namespace hc::sketch
