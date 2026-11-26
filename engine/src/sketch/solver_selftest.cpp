#include "sketch/solver_selftest.hpp"

#include "sketch/sketch_check.hpp"
#include "sketch/sketch_solver.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace hc::sketch {

namespace {

constexpr double kTolerance = 1e-8;  // mm and rad
constexpr int kExpectedDof = 0;
// 6 points x 2, the arc (radius, start and end angle), 4 driving values and the locked tangency angle
constexpr std::size_t kExpectedParameters = 20;

std::string number(double v) {
    char buf[40];
    std::snprintf(buf, sizeof buf, "%.10g", v);
    return buf;
}

std::string joined(const std::vector<std::string>& ids) {
    std::string s;
    for (const auto& id : ids) s += (s.empty() ? "" : ", ") + id;
    return s;
}

} // namespace

Sketch selftestSketch() {
    using T = ConstraintType;
    Sketch s;
    s.points = {{"A", 0.0, 0.0, true}, {"B", 55.0, 3.0, false},  {"C", 63.0, 37.0, false},
                {"D", -2.0, 44.0, false}, {"M", 58.0, 47.0, false}, {"E", 66.0, 53.0, false}};
    s.lines = {{"AB", "A", "B"}, {"BC", "B", "C"}, {"CD", "C", "D"}, {"DA", "D", "A"}, {"ME", "M", "E"}};
    s.arcs = {{"arc", "M", "C", "E", 8.0}};
    s.constraints = {
        {"horizontalAB", T::Horizontal, {"AB"}, 0.0, true},
        {"horizontalCD", T::Horizontal, {"CD"}, 0.0, true},
        {"verticalBC", T::Vertical, {"BC"}, 0.0, true},
        {"verticalDA", T::Vertical, {"DA"}, 0.0, true},
        {"widthAB", T::Distance, {"A", "B"}, 60.0, true},
        {"heightBC", T::Distance, {"B", "C"}, 40.0, true},
        {"tangentCD", T::Tangent, {"CD", "arc"}, 0.0, true},
        {"diameterArc", T::Diameter, {"arc"}, 20.0, true},
        {"angleME", T::LineAngle, {"ME"}, 0.0, true},
        {"referenceAE", T::Distance, {"A", "E"}, 0.0, false},
        {"referenceDiameter", T::Diameter, {"arc"}, 0.0, false},
    };
    return s;
}

std::map<std::string, std::pair<double, double>> selftestSolution() {
    return {{"A", {0.0, 0.0}},   {"B", {60.0, 0.0}},  {"C", {60.0, 40.0}}, {"D", {0.0, 40.0}},
            {"M", {60.0, 50.0}}, {"E", {70.0, 50.0}}, {"arc", {10.0, 0.0}}};
}

protocol::SolverSelftestResult runSelftest(const CancelCheck& cancelled) {
    throwIfCancelled(cancelled, "The solver self-test");
    protocol::SolverSelftestResult out;
    out.expectedDof = kExpectedDof;
    out.residualTolerance = kTolerance;
    const Sketch sketch = selftestSketch();
    const SolveResult r = solve(sketch);

    out.status = nameOf(r.status);
    out.dof = r.dof;
    out.conflicting = r.conflicting;
    out.redundant = r.redundant;
    out.parameterCount = static_cast<std::int64_t>(r.parameterCount);
    out.constraintCount = static_cast<std::int64_t>(r.solverConstraintCount);
    out.reference = r.reference;
    out.timeMs = r.timeMs;

    // Independent verification: residuals of every constraint and distance to the closed-form solution.
    const ResidualReport residuals = checkConstraints(r.geometry);
    out.maxResidual = residuals.maxResidual;
    double maxDeviation = 0.0;
    std::string worstDeviation;
    for (const auto& [id, xy] : selftestSolution()) {
        double d = 0.0;
        if (const Point* p = r.geometry.point(id)) d = std::hypot(p->x - xy.first, p->y - xy.second);
        else if (const Arc* a = r.geometry.arc(id)) d = std::abs(a->radius - xy.first);
        if (d >= maxDeviation) {
            maxDeviation = d;
            worstDeviation = id;
        }
    }
    out.maxDeviation = maxDeviation;

    const std::map<std::string, double> expectedReference = {{"referenceAE", std::hypot(70.0, 50.0)}, {"referenceDiameter", 20.0}};
    std::string problem;
    if (r.status != SolveStatus::Solved)
        problem = std::string("planegcs did not solve the self-test sketch (status ") + nameOf(r.status) +
                  (r.conflicting.empty() ? "" : ", conflicting: " + joined(r.conflicting)) +
                  (r.redundant.empty() ? "" : ", redundant: " + joined(r.redundant)) + ").";
    else if (r.dof != kExpectedDof)
        problem = "planegcs reports " + std::to_string(r.dof) + " degrees of freedom for the fully constrained self-test sketch instead of 0.";
    else if (!r.conflicting.empty() || !r.redundant.empty())
        problem = "The diagnosis of the solved sketch names conflicting (" + joined(r.conflicting) + ") or redundant (" +
                  joined(r.redundant) + ") constraints.";
    else if (!(residuals.maxResidual <= kTolerance))
        problem = "The solved geometry violates constraint \"" + residuals.worst + "\" by " + number(residuals.maxResidual) +
                  " (allowed " + number(kTolerance) + ").";
    else if (!(maxDeviation <= kTolerance))
        problem = "The solved position of \"" + worstDeviation + "\" is " + number(maxDeviation) +
                  " mm away from the closed-form solution (allowed " + number(kTolerance) + ").";
    else if (r.parameterCount != kExpectedParameters)
        problem = "The solver used " + std::to_string(r.parameterCount) + " parameters instead of " + std::to_string(kExpectedParameters) + ".";
    else {
        for (const auto& [id, value] : expectedReference) {
            const auto it = r.reference.find(id);
            if (it == r.reference.end()) {
                problem = "The reference dimension \"" + id + "\" was not measured.";
                break;
            }
            if (!(std::abs(it->second - value) <= kTolerance)) {
                problem = "The reference dimension \"" + id + "\" is " + number(it->second) + " instead of " + number(value) + ".";
                break;
            }
        }
    }
    out.passed = problem.empty();
    if (!problem.empty()) out.problem = problem;
    return out;
}

} // namespace hc::sketch
