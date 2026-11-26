#include "kernel/kernel_selftest.hpp"
#include "kernel/shape_check.hpp"

#include <BRepPrimAPI_MakeBox.hxx>
#include <gp_Pnt.hxx>

#include <doctest/doctest.h>

#include <cmath>

using namespace hc;

TEST_CASE("closed-form volume of the self-test part") {
    // Block 80000 minus hole 2000 pi minus the fillet ring (Pappus): 73587.33 mm^3.
    CHECK(kernel::selftestBlockVolume() == doctest::Approx(80000.0));
    CHECK(kernel::selftestHoleVolume() == doctest::Approx(80000.0 - 2000.0 * 3.14159265358979323846));
    CHECK(kernel::selftestFilletVolume() == doctest::Approx(73587.33).epsilon(1e-7));
}

TEST_CASE("kernel self-test passes and checks every operation") {
    const auto r = kernel::runSelftest({});
    INFO(r.problem.value_or(""));
    CHECK(r.passed);
    CHECK_FALSE(r.problem.has_value());
    REQUIRE(r.steps.size() == 3);
    CHECK(r.steps[0].name == "box");
    CHECK(r.steps[1].name == "hole");
    CHECK(r.steps[2].name == "fillet");
    for (const auto& s : r.steps) {
        CHECK(s.valid);
        CHECK(s.solidCount == 1);
        CHECK(s.faceCount == s.expectedFaceCount);
        CHECK(std::abs(s.volume - s.expectedVolume) / s.expectedVolume <= 1e-6);
    }
    CHECK(r.faceCount == 8);
    CHECK(r.volume == doctest::Approx(r.expectedVolume).epsilon(1e-6));
}

TEST_CASE("kernel self-test stops when cancelled") {
    bool threw = false;
    try {
        (void)kernel::runSelftest([] { return true; });
    } catch (const EngineError& e) {
        threw = true;
        CHECK(e.code() == "cancelled");
    }
    CHECK(threw);
}

TEST_CASE("plausibility check names wrong volume and face count") {
    const TopoDS_Shape box = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), gp_Pnt(10, 10, 10)).Shape();
    const kernel::ShapeFacts f = kernel::inspectShape(box);
    CHECK(f.valid);
    CHECK(f.faceCount == 6);
    CHECK(f.volume == doctest::Approx(1000.0));
    CHECK(kernel::checkPlausible(f, kernel::Expectation{1000.0, 1e-9, 6, 1}, "Box").empty());
    const std::string wrongVolume = kernel::checkPlausible(f, kernel::Expectation{999.0, 1e-6, 6, 1}, "Box");
    CHECK(wrongVolume.find("volume is 1000 mm^3 instead of 999 mm^3") != std::string::npos);
    const std::string wrongFaces = kernel::checkPlausible(f, kernel::Expectation{std::nullopt, 1e-6, 7, 1}, "Box");
    CHECK(wrongFaces.find("6 faces instead of 7") != std::string::npos);
    const kernel::ShapeFacts empty = kernel::inspectShape(TopoDS_Shape());
    CHECK_FALSE(empty.valid);
    CHECK(kernel::checkPlausible(empty, kernel::Expectation{}, "Cut").find("not a valid solid") != std::string::npos);
}
