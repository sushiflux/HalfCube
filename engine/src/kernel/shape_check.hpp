// Validity and plausibility check that runs after every modelling operation. OCCT can report success for an
// invalid or implausible result, so every result is checked with BRepCheck_Analyzer and its volume, face and solid
// counts are compared with what the operation should produce.
#pragma once

#include <TopoDS_Shape.hxx>

#include <optional>
#include <string>

namespace hc::kernel {

struct ShapeFacts {
    bool valid = false;  // BRepCheck_Analyzer::IsValid
    std::string faults;  // BRepCheck findings by sub-shape when invalid (at most 20)
    double volume = 0.0;  // mm^3
    int faceCount = 0;
    int solidCount = 0;
};

ShapeFacts inspectShape(const TopoDS_Shape& shape);

struct Expectation {
    std::optional<double> volume;     // expected volume in mm^3, compared with relativeTolerance
    double relativeTolerance = 1e-6;
    std::optional<int> faceCount;
    int solidCount = 1;
};

// Empty when the shape passes; otherwise a complete description of the first problem, naming the operation.
// Always required: valid, finite and positive volume, and the expected number of solids.
std::string checkPlausible(const ShapeFacts& facts, const Expectation& expected, const std::string& operation);

} // namespace hc::kernel
