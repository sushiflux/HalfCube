#include "sketch/sketch_check.hpp"
#include "sketch/sketch_solver.hpp"
#include "sketch/solver_selftest.hpp"

#include <doctest/doctest.h>

#include <algorithm>
#include <cmath>
#include <cstring>

using namespace pc::sketch;

namespace {

bool contains(const std::vector<std::string>& v, const std::string& s) { return std::find(v.begin(), v.end(), s) != v.end(); }

Constraint* findConstraint(Sketch& s, const std::string& id) {
    for (auto& c : s.constraints)
        if (c.id == id) return &c;
    return nullptr;
}

void removeConstraint(Sketch& s, const std::string& id) {
    s.constraints.erase(std::remove_if(s.constraints.begin(), s.constraints.end(), [&id](const Constraint& c) { return c.id == id; }),
                        s.constraints.end());
}

} // namespace

TEST_CASE("solver self-test passes") {
    const auto r = runSelftest({});
    INFO(r.problem.value_or(""));
    CHECK(r.passed);
    CHECK(r.status == "solved");
    CHECK(r.dof == 0);
    CHECK(r.parameterCount == 20);
    CHECK(r.constraintCount == 9);
    CHECK(r.maxResidual <= 1e-8);
    CHECK(r.maxDeviation <= 1e-8);
    CHECK(r.reference.at("referenceAE") == doctest::Approx(std::hypot(70.0, 50.0)).epsilon(1e-12));
    CHECK(r.reference.at("referenceDiameter") == doctest::Approx(20.0).epsilon(1e-12));
}

TEST_CASE("solving is bit-for-bit repeatable") {
    const Sketch s = selftestSketch();
    const SolveResult a = solve(s);
    const SolveResult b = solve(s);
    REQUIRE(a.geometry.points.size() == b.geometry.points.size());
    for (std::size_t i = 0; i < a.geometry.points.size(); ++i) {
        CHECK(std::memcmp(&a.geometry.points[i].x, &b.geometry.points[i].x, sizeof(double)) == 0);
        CHECK(std::memcmp(&a.geometry.points[i].y, &b.geometry.points[i].y, sizeof(double)) == 0);
    }
}

TEST_CASE("an under-constrained sketch reports its degrees of freedom") {
    Sketch s = selftestSketch();
    removeConstraint(s, "heightBC");
    const SolveResult r = solve(s);
    CHECK(r.status == SolveStatus::Solved);
    CHECK(r.dof == 1);
    CHECK(checkConstraints(r.geometry).maxResidual <= 1e-8);
}

TEST_CASE("conflicting dimensions are named") {
    Sketch s = selftestSketch();
    s.constraints.push_back({"widthAB2", ConstraintType::Distance, {"A", "B"}, 50.0, true});
    const SolveResult r = solve(s);
    CHECK(r.status == SolveStatus::Conflicting);
    CHECK(contains(r.conflicting, "widthAB2"));
    // The geometry stays as it was given.
    CHECK(r.geometry.point("B")->x == 55.0);
}

TEST_CASE("a conflicting line angle is named because its tag is kept") {
    Sketch s = selftestSketch();
    s.constraints.push_back({"angleME2", ConstraintType::LineAngle, {"ME"}, 0.5, true});
    const SolveResult r = solve(s);
    CHECK(r.status == SolveStatus::Conflicting);
    CHECK(contains(r.conflicting, "angleME2"));
}

TEST_CASE("a repeated constraint is reported as redundant") {
    Sketch s = selftestSketch();
    s.constraints.push_back({"horizontalAB2", ConstraintType::Horizontal, {"AB"}, 0.0, true});
    const SolveResult r = solve(s);
    CHECK(r.status == SolveStatus::Redundant);
    CHECK((contains(r.redundant, "horizontalAB2") || contains(r.redundant, "horizontalAB")));
}

TEST_CASE("reference dimensions never move geometry") {
    Sketch withReference = selftestSketch();
    removeConstraint(withReference, "heightBC");
    const Sketch without = withReference;
    // A reference length far from the real one must neither move points nor cost a degree of freedom.
    withReference.constraints.push_back({"referenceBC", ConstraintType::Distance, {"B", "C"}, 3.0, false});
    const SolveResult a = solve(withReference);
    const SolveResult b = solve(without);
    CHECK(a.dof == b.dof);
    for (std::size_t i = 0; i < a.geometry.points.size(); ++i) {
        CHECK(a.geometry.points[i].x == b.geometry.points[i].x);
        CHECK(a.geometry.points[i].y == b.geometry.points[i].y);
    }
    const Point& pb = *a.geometry.point("B");
    const Point& pc = *a.geometry.point("C");
    CHECK(a.reference.at("referenceBC") == doctest::Approx(std::hypot(pc.x - pb.x, pc.y - pb.y)));
}

TEST_CASE("a reference diameter is twice the radius") {
    Sketch s = selftestSketch();
    findConstraint(s, "diameterArc")->value = 14.0;
    const SolveResult r = solve(s);
    REQUIRE(r.status == SolveStatus::Solved);
    CHECK(r.geometry.arc("arc")->radius == doctest::Approx(7.0));
    CHECK(r.reference.at("referenceDiameter") == doctest::Approx(14.0));
}

TEST_CASE("invalid sketches are refused with a specific message") {
    Sketch s = selftestSketch();
    s.lines.push_back({"bad", "A", "nowhere"});
    CHECK_THROWS_WITH_AS(solve(s), "Line \"bad\" refers to \"nowhere\", which is no point of the sketch.", SketchError);
    Sketch t = selftestSketch();
    t.constraints.push_back({"badRef", ConstraintType::Horizontal, {"AB"}, 0.0, false});
    CHECK_THROWS_AS(solve(t), SketchError);
    Sketch u = selftestSketch();
    u.constraints.push_back({"badKind", ConstraintType::Radius, {"AB"}, 5.0, true});
    CHECK_THROWS_WITH_AS(solve(u), "Constraint \"badKind\" (radius) needs a circle or arc as reference 1, got \"AB\".", SketchError);
}

TEST_CASE("versions of the solver libraries") {
    CHECK(eigenVersion() == "3.4.0");
    CHECK(boostVersion() == "1.92.0");
}
