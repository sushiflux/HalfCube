// Recipe model of the engine: parses and validates recipes, rebuilds them step by step with OCCT and caches
// every step result so that a parameter change only recomputes the steps it affects.
#pragma once

#include "json.hpp"

#include <NCollection_DataMap.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS_Shape.hxx>

#include <cstdint>
#include <functional>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace pc {

// A recipe that cannot be used at all (wrong structure, unknown parameter reference, ...). The message names
// the JSON path of the problem.
class RecipeError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

// Thrown out of a rebuild when its cancel check returns true.
struct Cancelled {};

// Face -> id of the recipe step that created it.
using FaceOrigins = NCollection_DataMap<TopoDS_Shape, std::string, TopTools_ShapeMapHasher>;

struct StepCheck {
    bool valid = false;
    double volume = 0;
    int faces = 0;
    int solids = 0;
};

struct StepStatus {
    std::string stepId;
    std::string type;
    std::string status = "ok";  // ok | warning | error | skipped
    std::string message;        // full text, empty for ok
    bool cached = false;
    double ms = 0;
    bool hasCheck = false;
    StepCheck check;

    Json toJson() const;
};

struct StepDef {
    std::string id;
    std::string type;
    std::string body;  // empty for debug.spin
    Json raw;          // the step object as given; values are resolved at rebuild time
};

struct Recipe {
    std::map<std::string, double> params;
    std::vector<StepDef> steps;
    Json raw;
};

// Throws RecipeError. Debug steps (debug.spin) are accepted only when allowDebugSteps is set.
Recipe parseRecipe(const Json& j, bool allowDebugSteps);

struct BodyOut {
    std::string bodyId;
    std::string lastStepId;
    TopoDS_Shape shape;
    FaceOrigins origins;
    uint64_t key = 0;  // hash of every input that led to this shape
};

struct RebuildOut {
    std::vector<StepStatus> steps;
    std::vector<BodyOut> bodies;  // in order of creation; only bodies that have a shape
    std::string outcome;          // ok | warning | error
};

class Model {
public:
    using CancelFn = std::function<bool()>;
    using StepDoneFn = std::function<void(size_t index, const StepStatus&)>;

    // Rebuilds the recipe. Reuses cached step results whose inputs are unchanged. Throws Cancelled.
    RebuildOut rebuild(const Recipe& recipe, const CancelFn& cancelled, const StepDoneFn& stepDone);

private:
    struct CacheEntry {
        uint64_t key = 0;
        StepStatus status;
        bool hasShape = false;  // the step produced a new body state
        TopoDS_Shape shape;
        FaceOrigins origins;
    };
    std::map<std::string, CacheEntry> cache_;
};

// FNV-1a 64-bit, used for cache keys.
uint64_t fnv1a64(const std::string& s, uint64_t seed = 1469598103934665603ull);

} // namespace pc
