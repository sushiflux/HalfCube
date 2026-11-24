// Shared helpers of the OCCT kernel test: measurement, validity, face descriptions, meshing, STEP.
#pragma once

#include "json.hpp"

#include <TopoDS_Shape.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Edge.hxx>

#include <chrono>
#include <functional>
#include <string>
#include <vector>

namespace kt {

using Clock = std::chrono::steady_clock;

inline double msSince(Clock::time_point t0) {
    return std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
}

double median(std::vector<double> v);

// Kernel-reported properties of a shape plus the result of BRepCheck_Analyzer.
Json measure(const TopoDS_Shape& s);

// BRepCheck_Analyzer verdict; on failure lists the BRepCheck statuses found on sub-shapes.
bool isValid(const TopoDS_Shape& s, Json* details = nullptr);

// Second, independent check: BOPAlgo_ArgumentAnalyzer self-interference test.
Json selfInterference(const TopoDS_Shape& s);

// Human-readable description of a face: surface type and its defining parameters.
std::string describeFace(const TopoDS_Face& f);

// Triangulates with BRepMesh_IncrementalMesh and checks the mesh for cracks.
Json meshAndCheck(const TopoDS_Shape& s, double linDefl, double angDeflDeg, int runs);

#ifdef KT_WITH_STEP
// Writes the shape to STEP, reads it back and compares. Returns the comparison.
Json stepRoundTrip(const TopoDS_Shape& s, const std::string& path, bool ap242);
// Reads a STEP file into one shape. Throws std::runtime_error with the translator status on failure.
TopoDS_Shape readStep(const std::string& path, Json* info = nullptr);
void writeStep(const TopoDS_Shape& s, const std::string& path, bool ap242, Json* info = nullptr);
#endif

// Catches OCCT and standard exceptions and turns them into a message.
std::string describeCurrentException();

} // namespace kt
