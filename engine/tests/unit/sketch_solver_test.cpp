#include "sketch/sketch_check.hpp"
#include "sketch/sketch_freedom.hpp"
#include "sketch/sketch_solver.hpp"
#include "sketch/solver_selftest.hpp"

#include <doctest/doctest.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <numbers>

using namespace hc::sketch;

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

TEST_CASE("dragging: the real constraints hold, a free point reaches its target, the parameter block only grows at its end") {
    Sketch s = selftestSketch();
    removeConstraint(s, "heightBC");  // one degree of freedom: the rectangle can grow in height
    const SolveResult base = solve(s);
    REQUIRE(base.status == SolveStatus::Solved);

    SolveOptions o;
    o.drag = {{"D", base.geometry.point("D")->x, 52.0}};  // pull the top left corner straight up
    const SolveResult r = solve(base.geometry, o);
    REQUIRE(r.status == SolveStatus::Solved);
    REQUIRE(r.drag.has_value());
    CHECK(r.drag->complete);
    CHECK(r.drag->points[0].moved);
    CHECK(r.drag->points[0].error < 1e-6);
    CHECK(r.geometry.point("D")->y == doctest::Approx(52.0).epsilon(1e-7));
    CHECK(checkConstraints(r.geometry).maxResidual <= 1e-8);  // tangent arc, line angle, diameter and the rest still hold
    CHECK(r.parameterCount == base.parameterCount + 2);       // the target is the last block entry; nothing else shifted
    CHECK(r.dof == 1);

    // Repeatable bit for bit, like every solve.
    const SolveResult again = solve(base.geometry, o);
    for (std::size_t i = 0; i < r.geometry.points.size(); ++i) {
        CHECK(std::memcmp(&r.geometry.points[i].x, &again.geometry.points[i].x, sizeof(double)) == 0);
        CHECK(std::memcmp(&r.geometry.points[i].y, &again.geometry.points[i].y, sizeof(double)) == 0);
    }
}

TEST_CASE("dragging: a fixed point and a fully determined sketch do not move, a conflicting one is refused, bad targets are named") {
    const Sketch s = selftestSketch();  // fully determined; A is a fixed point
    const SolveResult base = solve(s);
    REQUIRE(base.status == SolveStatus::Solved);
    REQUIRE(base.dof == 0);

    SolveOptions toFixed;
    toFixed.drag = {{"A", 20.0, 20.0}};
    const SolveResult a = solve(base.geometry, toFixed);
    CHECK(a.status == SolveStatus::Solved);
    CHECK_FALSE(a.drag->points[0].moved);
    CHECK(a.drag->points[0].error == doctest::Approx(std::hypot(20.0, 20.0)));

    SolveOptions toDetermined;
    toDetermined.drag = {{"C", 90.0, 90.0}};
    const SolveResult c = solve(base.geometry, toDetermined);
    CHECK(c.status == SolveStatus::Solved);
    CHECK_FALSE(c.drag->points[0].moved);
    CHECK(c.drag->points[0].error > 50.0);
    CHECK(checkConstraints(c.geometry).maxResidual <= 1e-8);

    Sketch conflicting = base.geometry;
    conflicting.constraints.push_back({"widthAgain", ConstraintType::Distance, {"A", "B"}, 61.0, true});  // 60 and 61 mm
    SolveOptions toConflict;
    toConflict.drag = {{"M", 80.0, 60.0}};
    const SolveResult x = solve(conflicting, toConflict);
    CHECK(x.status == SolveStatus::Conflicting);
    CHECK_FALSE(x.drag->points[0].moved);  // a refused sketch stays as sent
    CHECK(x.geometry.point("M")->x == conflicting.point("M")->x);
    CHECK_FALSE(x.conflicting.empty());

    SolveOptions unknown;
    unknown.drag = {{"nope", 1.0, 1.0}};
    CHECK_THROWS_AS(solve(base.geometry, unknown), SketchError);
    SolveOptions twice;
    twice.drag = {{"B", 1.0, 1.0}, {"B", 2.0, 2.0}};
    CHECK_THROWS_AS(solve(base.geometry, twice), SketchError);
}

TEST_CASE("the distance kinds measure as planegcs does, and driving them reaches the value") {
    // A circle and a point on the left, a line below, a second circle far away.
    Sketch s;
    s.points = {{"A", 0, 0, false}, {"B", 10, 0, false}, {"O", 4, 8, false}, {"P", 20, 3, false}, {"Q", 30, 8, false}};
    s.lines = {{"L", "A", "B", false}};
    s.circles = {{"C1", "O", 2.0, false}, {"C2", "Q", 3.0, false}};
    s.constraints = {{"fixA", ConstraintType::Fix, {"A"}, 0.0, true}, {"fixB", ConstraintType::Fix, {"B"}, 0.0, true}};
    const auto m = [&](ConstraintType t, std::vector<std::string> refs) { return measure(s, Constraint{"x", t, std::move(refs), 0.0, false}); };
    CHECK(m(ConstraintType::DistancePointLine, {"P", "L"}) == doctest::Approx(3.0));
    CHECK(m(ConstraintType::DistanceCircleLine, {"C1", "L"}) == doctest::Approx(6.0));  // centre 8 from the line, radius 2
    CHECK(m(ConstraintType::DistancePointCircle, {"P", "C1"}) == doctest::Approx(std::hypot(16.0, 5.0) - 2.0));
    CHECK(m(ConstraintType::DistanceCircleCircle, {"C1", "C2"}) == doctest::Approx(26.0 - 5.0));
    // One inside the other: the room between the small circle and the big one's rim.
    s.points.push_back({"R", 31, 8, false});
    s.circles.push_back({"C3", "R", 1.0, false});
    CHECK(m(ConstraintType::DistanceCircleCircle, {"C2", "C3"}) == doctest::Approx(3.0 - (1.0 + 1.0)));

    // Driving: the point goes 5 mm from the line and the circle's rim 4 mm from the point.
    s.constraints.push_back({"pl", ConstraintType::DistancePointLine, {"P", "L"}, 5.0, true});
    s.constraints.push_back({"pc", ConstraintType::DistancePointCircle, {"P", "C1"}, 4.0, true});
    const SolveResult r = solve(s);
    REQUIRE(r.status == SolveStatus::Solved);
    CHECK(checkConstraints(r.geometry).maxResidual <= 1e-8);
    CHECK(std::abs(r.geometry.point("P")->y) == doctest::Approx(5.0));
}

TEST_CASE("an angle between rays is the corner between the rays, whatever way the lines run") {
    Sketch s;
    s.points = {{"A", 0, 0, false}, {"B", 10, 0, false}, {"D", 3, 4, false}};
    s.lines = {{"L1", "A", "B", false}, {"L4", "D", "A", false}};
    s.constraints = {{"fixA", ConstraintType::Fix, {"A"}, 0.0, true}, {"fixB", ConstraintType::Fix, {"B"}, 0.0, true}};
    Constraint corner{"corner", ConstraintType::LineLineAngle, {"L1", "L4"}, std::numbers::pi / 3.0, true};
    corner.rays = true;
    corner.reverse2 = true;  // the ray of L4 runs towards D
    s.constraints.push_back(corner);
    const SolveResult r = solve(s);
    REQUIRE(r.status == SolveStatus::Solved);
    CHECK(checkConstraints(r.geometry).maxResidual <= 1e-8);
    const Point& d = *r.geometry.point("D");
    CHECK(std::atan2(d.y, d.x) == doctest::Approx(std::numbers::pi / 3.0));
    // Without the flags the same lines would be asked for the angle between their directions: a different corner.
    Constraint plain = corner;
    plain.rays = false;
    plain.reverse2 = false;
    CHECK(measure(r.geometry, plain) != doctest::Approx(measure(r.geometry, corner)));
    // A value outside 0 to 180 degrees is refused for rays.
    Sketch bad = s;
    bad.constraints.back().value = 4.0;
    CHECK_THROWS_AS(solve(bad), SketchError);
}

TEST_CASE("freedom: the motions the constraints leave free are as many as the degrees of freedom planegcs counts, at every step") {
    Sketch s;
    s.points = {{"a", 0.4, -0.2, false}, {"b", 41, 0.3, false}, {"c", 40, 31, false}, {"d", -0.3, 30, false}, {"o", 20, 15, false}, {"e", 60, 5, false}};
    s.lines = {{"l1", "a", "b", false}, {"l2", "b", "c", false}, {"l3", "c", "d", false}, {"l4", "d", "a", false}, {"m", "o", "e", false}};
    s.circles = {{"k", "e", 4.0, false}};
    const std::vector<Constraint> steps = {
        {"h1", ConstraintType::Horizontal, {"l1"}, 0.0, true},
        {"h3", ConstraintType::Horizontal, {"l3"}, 0.0, true},
        {"v2", ConstraintType::Vertical, {"l2"}, 0.0, true},
        {"v4", ConstraintType::Vertical, {"l4"}, 0.0, true},
        {"w", ConstraintType::Distance, {"l1"}, 40.0, true},
        {"hh", ConstraintType::Distance, {"l2"}, 30.0, true},
        {"org", ConstraintType::Coincident, {"a", "@origin"}, 0.0, true},
        {"mo", ConstraintType::PointOnCircle, {"o", "k"}, 0.0, true},
        {"dia", ConstraintType::Diameter, {"k"}, 8.0, true},
        {"ml", ConstraintType::Distance, {"m"}, 40.0, true},
        {"ang", ConstraintType::LineAngle, {"m"}, 0.3, true},
        {"pin", ConstraintType::Fix, {"e"}, 0.0, true},
    };
    for (const Constraint& c : steps) {
        s.constraints.push_back(c);
        const SolveResult r = solve(s);
        if (r.status != SolveStatus::Solved) {
            s.constraints.pop_back();  // a step that does not fit the geometry is left out
            continue;
        }
        const FreedomReport f = analyseFreedom(r.geometry);
        INFO("after " << c.id);
        CHECK(f.analysed);
        CHECK(f.freeMotions == r.dof);
        s.points = r.geometry.points;
        s.circles = r.geometry.circles;
    }
}
