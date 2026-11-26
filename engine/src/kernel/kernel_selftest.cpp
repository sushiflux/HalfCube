#include "kernel/kernel_selftest.hpp"

#include "kernel/shape_check.hpp"

#include <BRepAdaptor_Curve.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <gp_Ax2.hxx>
#include <gp_Circ.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>

#include <chrono>
#include <cmath>
#include <functional>
#include <numbers>

namespace hc::kernel {

namespace {

constexpr double kLength = 80.0, kWidth = 50.0, kHeight = 20.0;
constexpr double kHoleX = 40.0, kHoleY = 25.0, kHoleRadius = 10.0;
constexpr double kFilletRadius = 3.0;
constexpr double kVolumeTolerance = 1e-6;  // relative; the fillet surface is a torus, its volume is integrated

using Clock = std::chrono::steady_clock;
double msSince(Clock::time_point t0) { return std::chrono::duration<double, std::milli>(Clock::now() - t0).count(); }

// Circular edge of the hole where it meets the top face (z = kHeight).
bool findHoleTopEdge(const TopoDS_Shape& body, TopoDS_Edge& out) {
    for (TopExp_Explorer ex(body, TopAbs_EDGE); ex.More(); ex.Next()) {
        const TopoDS_Edge& e = TopoDS::Edge(ex.Current());
        const BRepAdaptor_Curve c(e);
        if (c.GetType() != GeomAbs_Circle) continue;
        const gp_Circ ci = c.Circle();
        if (std::abs(ci.Radius() - kHoleRadius) > 1e-7) continue;
        if (std::abs(ci.Location().X() - kHoleX) > 1e-7 || std::abs(ci.Location().Y() - kHoleY) > 1e-7) continue;
        if (std::abs(ci.Location().Z() - kHeight) > 1e-7) continue;
        out = e;
        return true;
    }
    return false;
}

} // namespace

double selftestBlockVolume() { return kLength * kWidth * kHeight; }

double selftestHoleVolume() { return selftestBlockVolume() - std::numbers::pi * kHoleRadius * kHoleRadius * kHeight; }

// The fillet removes a ring around the hole axis whose cross-section is the square r x r minus a quarter disc of
// radius r ("spandrel", area r^2 (1 - pi/4)). Its centroid lies r (5/6 - pi/4) / (1 - pi/4) away from the edge,
// i.e. at radius R + that from the axis; Pappus' theorem gives the removed volume 2 pi rho A.
double selftestFilletVolume() {
    const double r = kFilletRadius;
    const double area = r * r * (1.0 - std::numbers::pi / 4.0);
    const double rho = kHoleRadius + r * (5.0 / 6.0 - std::numbers::pi / 4.0) / (1.0 - std::numbers::pi / 4.0);
    return selftestHoleVolume() - 2.0 * std::numbers::pi * rho * area;
}

protocol::KernelSelftestResult runSelftest(const CancelCheck& cancelled) {
    protocol::KernelSelftestResult result;
    result.expectedVolume = selftestFilletVolume();
    result.expectedFaceCount = 8;
    result.volumeTolerance = kVolumeTolerance;
    const auto tAll = Clock::now();

    // Runs one operation, checks its result and records the step. Returns false when the self-test must stop.
    TopoDS_Shape current;
    const auto step = [&](const char* name, double expectedVolume, int expectedFaces,
                          const std::function<TopoDS_Shape(std::string& problem)>& operation) {
        throwIfCancelled(cancelled, std::string("The kernel self-test (before the step \"") + name + "\")");
        protocol::KernelSelftestStep s;
        s.name = name;
        s.expectedVolume = expectedVolume;
        s.expectedFaceCount = expectedFaces;
        const auto t0 = Clock::now();
        std::string problem;
        TopoDS_Shape shape;
        try {
            shape = operation(problem);
        } catch (...) {
            problem = std::string("Step \"") + name + "\": OCCT raised an exception: " + describeCurrentException();
        }
        if (problem.empty()) {
            const ShapeFacts facts = inspectShape(shape);
            s.valid = facts.valid;
            s.volume = facts.volume;
            s.faceCount = facts.faceCount;
            s.solidCount = facts.solidCount;
            problem = checkPlausible(facts, Expectation{expectedVolume, kVolumeTolerance, expectedFaces, 1},
                                     std::string("Step \"") + name + "\"");
        }
        s.timeMs = msSince(t0);
        if (!problem.empty()) s.problem = problem;
        result.steps.push_back(s);
        if (!problem.empty()) {
            result.problem = problem;
            return false;
        }
        current = shape;
        result.volume = s.volume;
        result.faceCount = s.faceCount;
        return true;
    };

    const bool ok =
        step("box", selftestBlockVolume(), 6,
             [](std::string&) { return BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), gp_Pnt(kLength, kWidth, kHeight)).Shape(); }) &&
        step("hole", selftestHoleVolume(), 7,
             [&](std::string& problem) {
                 // The tool overshoots the block by 1 mm at both ends, so the cut has no coplanar faces.
                 const gp_Ax2 axis(gp_Pnt(kHoleX, kHoleY, -1.0), gp_Dir(gp_Dir::D::Z), gp_Dir(gp_Dir::D::X));
                 const TopoDS_Shape tool = BRepPrimAPI_MakeCylinder(axis, kHoleRadius, kHeight + 2.0).Shape();
                 BRepAlgoAPI_Cut cut(current, tool);
                 if (!cut.IsDone()) {
                     problem = "Step \"hole\": the Boolean cut reports failure (BRepAlgoAPI_Cut::IsDone is false).";
                     return TopoDS_Shape();
                 }
                 return cut.Shape();
             }) &&
        step("fillet", selftestFilletVolume(), 8, [&](std::string& problem) {
            TopoDS_Edge edge;
            if (!findHoleTopEdge(current, edge)) {
                problem = "Step \"fillet\": the circular edge of the hole at the top face was not found.";
                return TopoDS_Shape();
            }
            BRepFilletAPI_MakeFillet fillet(current);
            fillet.Add(kFilletRadius, edge);
            fillet.Build();
            if (!fillet.IsDone()) {
                problem = "Step \"fillet\": the fillet of 3 mm reports failure (BRepFilletAPI_MakeFillet::IsDone is false).";
                return TopoDS_Shape();
            }
            return fillet.Shape();
        });

    result.passed = ok;
    if (!ok) {
        result.volume = 0.0;
        result.faceCount = 0;
    }
    result.timeMs = msSince(tAll);
    return result;
}

} // namespace hc::kernel
