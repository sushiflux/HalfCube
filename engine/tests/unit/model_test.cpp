// sketch.solve and model.sync through the engine core, exactly as a client sends them.
#include "core/engine.hpp"
#include "core/errors.hpp"
#include "model/document.hpp"
#include "model/geometry.hpp"
#include "model/model.hpp"
#include "model/profiles.hpp"
#include "sketch/sketch_solver.hpp"

#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>

#include <doctest/doctest.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <numbers>
#include <set>
#include <string>
#include <tuple>
#include <vector>

using namespace pc;

namespace {

struct Reply {
    Json header;
    std::vector<std::uint8_t> payload;
};

class CaptureOutput : public Output {
public:
    void send(const std::string& header, const std::vector<std::uint8_t>* payload) override {
        replies.push_back({Json::parse(header), payload ? *payload : std::vector<std::uint8_t>{}});
    }
    std::vector<Reply> replies;
};

class Client {
public:
    Client() : engine_(out_, EngineOptions{}) {
        call(Json{{"type", "hello"}, {"protocol", protocol::kVersion}, {"protocolId", protocol::kProtocolId}, {"client", "unit test"}});
    }

    Reply call(Json msg) {
        msg["id"] = ++id_;
        engine_.receive(msg.dump(), {});
        while (engine_.runNext(false)) {
        }
        REQUIRE_FALSE(out_.replies.empty());
        Reply r = out_.replies.back();
        CHECK(r.header["replyTo"] == id_);
        return r;
    }

    Reply solve(const Json& sketch, Json extra = Json::object(), const std::string& plane = "xy") {
        Json msg{{"type", "sketch.solve"}, {"sketch", sketch}, {"plane", {{"kind", "originPlane"}, {"plane", plane}}}};
        for (auto it = extra.begin(); it != extra.end(); ++it) msg[it.key()] = it.value();
        return call(msg);
    }

    Reply sync(const Json& document, const std::string& purpose = "commit") {
        return call(Json{{"type", "model.sync"}, {"revision", ++revision_}, {"document", document}, {"purpose", purpose}});
    }

    std::int64_t revision_ = 0;

private:
    CaptureOutput out_;
    Engine engine_;
    std::int64_t id_ = 0;
};

Json mm(double v) { return Json{{"value", v}, {"unit", "mm"}}; }
Json deg(double v) { return Json{{"value", v}, {"unit", "deg"}}; }
Json point(const std::string& id, double x, double y) { return Json{{"id", id}, {"x", x}, {"y", y}}; }
Json line(const std::string& id, const std::string& a, const std::string& b, bool construction = false) {
    return Json{{"id", id}, {"p1", a}, {"p2", b}, {"construction", construction}};
}
Json circle(const std::string& id, const std::string& center, double r) {
    return Json{{"id", id}, {"center", center}, {"radius", r}, {"construction", false}};
}
Json constraint(const std::string& id, const std::string& kind, std::vector<std::string> refs) {
    return Json{{"id", id}, {"kind", kind}, {"refs", refs}};
}
Json dimension(const std::string& id, const std::string& kind, std::vector<std::string> refs, Json value, bool driving = true) {
    return Json{{"id", id}, {"kind", kind}, {"refs", refs}, {"value", value}, {"driving", driving}, {"label", {{"x", 0.0}, {"y", 0.0}}}};
}

// Rectangle p1..p4 / l1..l4 starting slightly off 60 x 40 so the solver has work to do. Steps add the constraints in
// the order of the DOF test: 0 none, 1 horizontal/vertical, 2 the two dimensions, 3 the corner at the origin.
Json rectangle(int steps = 3, double width = 60.0, double height = 40.0) {
    Json s{{"points", Json::array({point("p1", 0.5, -0.3), point("p2", 61, 0.2), point("p3", 59, 41), point("p4", -0.4, 39)})},
           {"lines", Json::array({line("l1", "p1", "p2"), line("l2", "p2", "p3"), line("l3", "p3", "p4"), line("l4", "p4", "p1")})},
           {"circles", Json::array()},
           {"constraints", Json::array()}};
    auto& c = s["constraints"];
    if (steps >= 1) {
        c.push_back(constraint("k1", "horizontal", {"l1"}));
        c.push_back(constraint("k2", "horizontal", {"l3"}));
        c.push_back(constraint("k3", "vertical", {"l2"}));
        c.push_back(constraint("k4", "vertical", {"l4"}));
    }
    if (steps >= 2) {
        c.push_back(dimension("d1", "distance", {"l1"}, mm(width)));
        c.push_back(dimension("d2", "distance", {"l2"}, mm(height)));
    }
    if (steps >= 3) c.push_back(constraint("k5", "coincident", {"p1", "@origin"}));
    return s;
}

Json document(const Json& sketch, const std::string& extent = "oneSide", double distance = 10.0, const std::string& region = "l1,l2,l3,l4",
              const std::string& plane = "xy") {
    return Json{{"format", 1},
                {"documentId", "doc-test"},
                {"settings", {{"lengthUnit", "mm"}}},
                {"nextId", 100},
                {"parameters", Json::array()},
                {"components", Json::array({{{"id", "root"},
                                             {"name", "Teil"},
                                             {"bodies", Json::array({{{"id", "b1"}, {"name", "Körper1"}, {"createdBy", "f2"}, {"visible", true}}})}}})},
                {"timeline", Json::array({{{"id", "f1"},
                                           {"type", "sketch"},
                                           {"name", "Skizze1"},
                                           {"component", "root"},
                                           {"visible", true},
                                           {"plane", {{"kind", "originPlane"}, {"plane", plane}}},
                                           {"sketch", sketch}},
                                          {{"id", "f2"},
                                           {"type", "extrude"},
                                           {"name", "Extrusion1"},
                                           {"component", "root"},
                                           {"profile", {{"sketch", "f1"}, {"region", region}}},
                                           {"extent", extent},
                                           {"distance", mm(distance)},
                                           {"operation", "newBody"},
                                           {"body", "b1"}}})}};
}

Json pointOf(const Reply& r, const std::string& id) {
    for (const auto& p : r.header["points"])
        if (p["id"] == id) return p;
    FAIL("point " << id << " missing");
    return {};
}

std::set<std::string> names(const Json& list) {
    std::set<std::string> s;
    for (const auto& e : list) s.insert(e["name"].get<std::string>());
    return s;
}

template <class T>
std::vector<T> buffer(const Reply& r, const Json& ref) {
    const auto offset = ref["offset"].get<std::size_t>();
    const auto length = ref["byteLength"].get<std::size_t>();
    REQUIRE(offset % protocol::kPayloadAlignment == 0);
    REQUIRE(offset + length <= r.payload.size());
    REQUIRE(length % sizeof(T) == 0);
    std::vector<T> v(length / sizeof(T));
    if (length) std::memcpy(v.data(), r.payload.data() + offset, length);
    return v;
}

} // namespace

TEST_CASE("sketch.solve: degrees of freedom fall 8, 4, 2, 0 and the rectangle becomes fully defined") {
    Client c;
    const int expected[] = {8, 4, 2, 0};
    for (int step = 0; step <= 3; ++step) {
        const Reply r = c.solve(rectangle(step));
        INFO("step " << step);
        CHECK(r.header["type"] == "sketchSolveResult");
        CHECK(r.header["status"] == "solved");
        CHECK(r.header["dof"] == expected[step]);
        CHECK_FALSE(r.header.contains("problem"));
    }
    const Reply r = c.solve(rectangle(3));
    for (const auto& id : {"p1", "p2", "p3", "p4", "l1", "l2", "l3", "l4"}) CHECK(r.header["entities"][id] == "full");
    CHECK(pointOf(r, "p1")["x"].get<double>() == doctest::Approx(0.0).epsilon(1e-9));
    CHECK(pointOf(r, "p3")["x"].get<double>() == doctest::Approx(60.0).epsilon(1e-9));
    CHECK(pointOf(r, "p3")["y"].get<double>() == doctest::Approx(40.0).epsilon(1e-9));
    CHECK(r.header["constraints"]["d1"] == "ok");
    CHECK(r.header["profiles"].empty());  // only asked for by the extrude command
    CHECK(r.payload.empty());
    CHECK(r.header["frame"]["normal"]["z"] == 1.0);

    const Reply under = c.solve(rectangle(1));
    CHECK(under.header["entities"]["p3"] == "under");
}

TEST_CASE("sketch steps are accepted and ignored, in sketch.solve and in model.sync") {
    Client c;
    Json withSteps = rectangle(3);
    withSteps["steps"] = Json::array({{{"id", "s1"}, {"kind", "rectangle"}, {"members", Json::array({"p1", "p2", "l1"})}}});
    const Reply plain = c.solve(rectangle(3));
    const Reply stepped = c.solve(withSteps);
    CHECK(stepped.header["type"] == "sketchSolveResult");
    CHECK(stepped.header["points"] == plain.header["points"]);
    CHECK(c.sync(document(withSteps)).header["type"] == "modelResult");
    // A step with an unknown kind is refused like any other bad field.
    withSteps["steps"][0]["kind"] = "polygon";
    CHECK(c.sync(document(withSteps)).header["code"] == "bad_document");
}

TEST_CASE("sketch.solve: the same sketch gives bit-identical results") {
    Client c;
    const Reply a = c.solve(rectangle(3));
    const Reply b = c.solve(rectangle(3));
    CHECK(a.header["points"].dump() == b.header["points"].dump());
}

TEST_CASE("sketch.solve: a contradicting dimension is answered as a conflict and the geometry stays as sent") {
    Client c;
    Json s = rectangle(3);
    s["constraints"].push_back(dimension("d3", "distance", {"l3"}, mm(50)));
    const Reply r = c.solve(s);
    CHECK(r.header["status"] == "conflicting");
    const auto conflicting = r.header["conflicting"].get<std::vector<std::string>>();
    CHECK(std::find(conflicting.begin(), conflicting.end(), "d3") != conflicting.end());
    CHECK(r.header["problem"]["code"] == "sketch_conflicting");
    CHECK(r.header["constraints"]["d3"] == "conflicting");
    CHECK(pointOf(r, "p2")["x"] == 61.0);  // unchanged input position

    // The same dimension as a reference dimension: solvable, measured after solving.
    s["constraints"].back()["driving"] = false;
    const Reply ref = c.solve(s);
    CHECK(ref.header["status"] == "solved");
    CHECK(ref.header["dof"] == 0);
    CHECK(ref.header["reference"]["d3"].get<double>() == doctest::Approx(60.0).epsilon(1e-9));
}

TEST_CASE("sketch.solve: reference dimensions do not move free geometry (N11) and angles come back in degrees") {
    Client c;
    Json s{{"points", Json::array({point("a", 0, 0), point("b", 30, 0), point("c", 0, 0.0), point("d", 20, 20)})},
           {"lines", Json::array({line("m1", "a", "b"), line("m2", "c", "d")})},
           {"circles", Json::array()},
           {"constraints", Json::array({dimension("r1", "distance", {"m1"}, mm(50), false), dimension("r2", "angle", {"m1", "m2"}, deg(10), false)})}};
    const Reply r = c.solve(s);
    CHECK(r.header["status"] == "solved");
    CHECK(r.header["dof"] == 8);
    CHECK(pointOf(r, "b")["x"] == 30.0);
    CHECK(r.header["reference"]["r1"].get<double>() == doctest::Approx(30.0).epsilon(1e-12));
    CHECK(r.header["reference"]["r2"].get<double>() == doctest::Approx(45.0).epsilon(1e-9));
}

TEST_CASE("sketch.solve: circles, fix, equal, pointOnCurve, distanceX/Y and an angle to an axis") {
    Client c;
    Json s{{"points", Json::array({point("o", 1, 1), point("q", 10, 3), point("e", 30, 5)})},
           {"lines", Json::array({line("n1", "q", "e")})},
           {"circles", Json::array({circle("c1", "o", 4), circle("c2", "q", 7)})},
           {"constraints", Json::array({constraint("k1", "fix", {"o"}), dimension("d1", "diameter", {"c1"}, mm(10)), constraint("k2", "equal", {"c1", "c2"}),
                                        dimension("d2", "distanceX", {"o", "q"}, mm(20)), constraint("k3", "pointOnCurve", {"q", "c1"}),
                                        dimension("d3", "angle", {"@axisU", "n1"}, deg(30)), dimension("d4", "distance", {"n1"}, mm(25))})}};
    const Reply r = c.solve(s);
    INFO(r.header.dump());
    // q on c1 (radius 5 around the fixed o at (1,1)) and 20 mm to the right of o cannot both hold.
    CHECK(r.header["status"] != "solved");

    s["constraints"][3]["value"] = mm(3);  // q 3 mm right of o on the circle: (4, 1 + 4), the branch near the start
    const Reply ok = c.solve(s);
    INFO(ok.header.dump());
    REQUIRE(ok.header["status"] == "solved");
    CHECK(ok.header["dof"] == 0);
    CHECK(pointOf(ok, "q")["x"].get<double>() == doctest::Approx(4.0).epsilon(1e-9));
    CHECK(pointOf(ok, "q")["y"].get<double>() == doctest::Approx(5.0).epsilon(1e-9));
    const double ex = pointOf(ok, "e")["x"].get<double>(), ey = pointOf(ok, "e")["y"].get<double>();
    CHECK(ex == doctest::Approx(4.0 + 25.0 * std::cos(std::numbers::pi / 6)).epsilon(1e-9));
    CHECK(ey == doctest::Approx(5.0 + 25.0 * std::sin(std::numbers::pi / 6)).epsilon(1e-9));
    for (const auto& circleResult : ok.header["circles"]) CHECK(circleResult["radius"].get<double>() == doctest::Approx(5.0).epsilon(1e-9));
}

TEST_CASE("sketch.solve: element ids must not be the reserved origin ids") {
    Client c;
    Json s = rectangle(0);
    s["points"][0]["id"] = "@origin";
    const Reply r = c.solve(s);
    CHECK(r.header["type"] == "error");
    CHECK(r.header["code"] == "bad_document");
}

TEST_CASE("sketch.solve with profiles: regions with keys, areas and fill triangles") {
    Client c;
    Json s = rectangle(3);
    s["points"].push_back(point("pc", 20, 20));
    s["circles"].push_back(circle("c1", "pc", 5));
    const Reply r = c.solve(s, Json{{"profiles", true}});
    REQUIRE(r.header["status"] == "solved");
    const Json& regions = r.header["profiles"];
    REQUIRE(regions.size() == 2);
    CHECK(regions[0]["key"] == "c1");
    CHECK(regions[1]["key"] == "l1,l2,l3,l4|c1");
    CHECK(regions[0]["area"].get<double>() == doctest::Approx(25.0 * std::numbers::pi).epsilon(1e-9));
    CHECK(regions[1]["area"].get<double>() == doctest::Approx(2400.0 - 25.0 * std::numbers::pi).epsilon(1e-9));
    for (const auto& region : regions) {
        const auto uv = buffer<float>(r, region["fill"]["positions"]);
        const auto idx = buffer<std::uint32_t>(r, region["fill"]["indices"]);
        CHECK(idx.size() == 3 * region["fill"]["triangleCount"].get<std::size_t>());
        CHECK(idx.size() > 0);
        double area = 0.0;
        for (std::size_t i = 0; i + 2 < idx.size(); i += 3) {
            const float* a = &uv[2 * idx[i]];
            const float* b = &uv[2 * idx[i + 1]];
            const float* d = &uv[2 * idx[i + 2]];
            const double t = 0.5 * ((b[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (b[1] - a[1]));
            CHECK(t > 0.0);  // counter-clockwise
            area += t;
        }
        CHECK(area == doctest::Approx(region["area"].get<double>()).epsilon(0.01));  // circle polygonised
    }
}

TEST_CASE("profiles: an open sketch has no region, crossing curves are reported") {
    Client c;
    Json open = rectangle(3);
    open["lines"].erase(3);
    open["constraints"].erase(3);  // k4 (vertical l4)
    const Reply r = c.solve(open, Json{{"profiles", true}});
    CHECK(r.header["profiles"].empty());

    Json crossing = rectangle(3);
    crossing["points"].push_back(point("x1", 30, -10));
    crossing["points"].push_back(point("x2", 30, 50));
    crossing["lines"].push_back(line("l5", "x1", "x2"));
    const Reply x = c.solve(crossing, Json{{"profiles", true}});
    REQUIRE(x.header.contains("problem"));
    CHECK(x.header["problem"]["code"] == "profile_intersecting");
}

TEST_CASE("model.sync: extrusion of the rectangle with names, checks and a mesh") {
    Client c;
    const Reply r = c.sync(document(rectangle(3)));
    INFO(r.header.dump().substr(0, 2000));
    REQUIRE(r.header["type"] == "modelResult");
    CHECK(r.header["outcome"] == "ok");
    REQUIRE(r.header["steps"].size() == 2);
    CHECK(r.header["steps"][0]["state"] == "ok");
    CHECK(r.header["steps"][1]["state"] == "ok");
    CHECK(r.header["steps"][1]["check"]["volume"].get<double>() == doctest::Approx(24000.0).epsilon(1e-6));
    CHECK(r.header["steps"][1]["check"]["faces"] == 6);
    REQUIRE(r.header["bodies"].size() == 1);
    const Json& body = r.header["bodies"][0];
    CHECK(body["bodyId"] == "b1");
    CHECK(body["preview"] == false);
    CHECK(body["volume"].get<double>() == doctest::Approx(24000.0).epsilon(1e-6));
    CHECK(body["area"].get<double>() == doctest::Approx(2 * 2400.0 + 2 * 60 * 10 + 2 * 40 * 10).epsilon(1e-6));
    CHECK(names(body["faces"]) == std::set<std::string>{"f2:start", "f2:end", "f2:side:l1", "f2:side:l2", "f2:side:l3", "f2:side:l4"});
    CHECK(names(body["edges"]).size() == 12);
    CHECK(names(body["edges"]).count("f2:lateral:p1") == 1);
    CHECK(body["bbox"]["min"]["z"].get<double>() == doctest::Approx(0.0).epsilon(1e-6));
    CHECK(body["bbox"]["max"]["z"].get<double>() == doctest::Approx(10.0).epsilon(1e-6));

    // Mesh: aligned buffers, every triangle belongs to a face, normals point away from the box centre.
    const Json& mesh = body["mesh"];
    const auto pos = buffer<float>(r, mesh["positions"]);
    const auto nrm = buffer<float>(r, mesh["normals"]);
    const auto idx = buffer<std::uint32_t>(r, mesh["indices"]);
    const auto tf = buffer<std::uint32_t>(r, mesh["triangleFace"]);
    const auto edges = buffer<float>(r, mesh["edgePoints"]);
    CHECK(pos.size() == 3 * mesh["vertexCount"].get<std::size_t>());
    CHECK(nrm.size() == pos.size());
    CHECK(idx.size() == 3 * mesh["triangleCount"].get<std::size_t>());
    CHECK(tf.size() == mesh["triangleCount"].get<std::size_t>());
    CHECK(edges.size() == 3 * mesh["edgePointCount"].get<std::size_t>());
    std::size_t covered = 0;
    for (const auto& f : body["faces"]) covered += f["triangleCount"].get<std::size_t>();
    CHECK(covered == tf.size());
    const float centre[3] = {30.0f, 20.0f, 5.0f};
    for (std::size_t t = 0; t < tf.size(); ++t) {
        const std::uint32_t a = idx[3 * t], b = idx[3 * t + 1], d = idx[3 * t + 2];
        const float* pa = &pos[3 * a];
        const float* pb = &pos[3 * b];
        const float* pd = &pos[3 * d];
        const float u[3] = {pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]};
        const float v[3] = {pd[0] - pa[0], pd[1] - pa[1], pd[2] - pa[2]};
        const float n[3] = {u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]};
        const float out[3] = {pa[0] - centre[0], pa[1] - centre[1], pa[2] - centre[2]};
        CHECK(n[0] * out[0] + n[1] * out[1] + n[2] * out[2] > 0.0f);
        CHECK(nrm[3 * a] * n[0] + nrm[3 * a + 1] * n[1] + nrm[3 * a + 2] * n[2] > 0.0f);
    }
}

TEST_CASE("model.sync: planes, directions and symmetric extent (total thickness)") {
    struct Case {
        const char* plane;
        const char* extent;
        double distance;
        double min[3], max[3];
    };
    const Case cases[] = {
        {"xy", "oneSide", -10, {0, 0, -10}, {60, 40, 0}},
        {"xy", "symmetric", 10, {0, 0, -5}, {60, 40, 5}},
        {"xz", "oneSide", 10, {0, -10, 0}, {60, 0, 40}},
        {"yz", "oneSide", 10, {0, 0, 0}, {10, 60, 40}},
    };
    for (const auto& k : cases) {
        Client c;
        const Reply r = c.sync(document(rectangle(3), k.extent, k.distance, "l1,l2,l3,l4", k.plane));
        INFO(k.plane << " " << k.extent << " " << k.distance);
        REQUIRE(r.header["outcome"] == "ok");
        const Json& bb = r.header["bodies"][0]["bbox"];
        const char* axes[3] = {"x", "y", "z"};
        for (int a = 0; a < 3; ++a) {
            CHECK(bb["min"][axes[a]].get<double>() == doctest::Approx(k.min[a]).epsilon(1e-6).scale(1.0));
            CHECK(bb["max"][axes[a]].get<double>() == doctest::Approx(k.max[a]).epsilon(1e-6).scale(1.0));
        }
        CHECK(r.header["bodies"][0]["volume"].get<double>() == doctest::Approx(24000.0).epsilon(1e-6));
    }
}

TEST_CASE("model.sync: holes give two more faces and seam names; a changed dimension keeps every name") {
    Client c;
    Json s = rectangle(3);
    s["points"].push_back(point("pc", 20, 20));
    s["circles"].push_back(circle("c1", "pc", 5));
    s["constraints"].push_back(constraint("k6", "fix", {"pc"}));
    s["constraints"].push_back(dimension("d3", "radius", {"c1"}, mm(5)));
    const Reply r = c.sync(document(s, "oneSide", 10, "l1,l2,l3,l4|c1"));
    REQUIRE(r.header["outcome"] == "ok");
    const Json& body = r.header["bodies"][0];
    CHECK(body["faces"].size() == 7);
    CHECK(names(body["faces"]).count("f2:side:c1") == 1);
    CHECK(names(body["edges"]).count("f2:seam:c1") == 0);  // seams are not drawn
    CHECK(names(body["edges"]).count("f2:start:c1") == 1);
    CHECK(body["volume"].get<double>() == doctest::Approx((2400.0 - 25.0 * std::numbers::pi) * 10.0).epsilon(1e-6));

    s["constraints"][4]["value"] = mm(80);  // d1
    const Reply wider = c.sync(document(s, "oneSide", 10, "l1,l2,l3,l4|c1"));
    REQUIRE(wider.header["outcome"] == "ok");
    CHECK(names(wider.header["bodies"][0]["faces"]) == names(body["faces"]));
    CHECK(names(wider.header["bodies"][0]["edges"]) == names(body["edges"]));
    CHECK(wider.header["bodies"][0]["volume"].get<double>() == doctest::Approx((3200.0 - 25.0 * std::numbers::pi) * 10.0).epsilon(1e-6));
    CHECK(wider.header["bodies"][0]["meshKey"] != body["meshKey"]);
}

TEST_CASE("model.sync: unchanged steps come from the cache; old revisions are refused") {
    Client c;
    const Json doc = document(rectangle(3));
    const Reply first = c.sync(doc);
    CHECK(first.header["steps"][0]["cached"] == false);
    const Reply second = c.sync(doc);
    CHECK(second.header["steps"][0]["cached"] == true);
    CHECK(second.header["steps"][1]["cached"] == true);
    CHECK(second.header["bodies"][0]["meshKey"] == first.header["bodies"][0]["meshKey"]);
    CHECK(second.payload == first.payload);

    // Only the extrusion changes: the sketch stays cached.
    const Reply third = c.sync(document(rectangle(3), "oneSide", 20));
    CHECK(third.header["steps"][0]["cached"] == true);
    CHECK(third.header["steps"][1]["cached"] == false);

    const Reply stale =
        c.call(Json{{"type", "model.sync"}, {"revision", c.revision_}, {"document", doc}, {"purpose", "commit"}});
    CHECK(stale.header["type"] == "error");
    CHECK(stale.header["code"] == "stale_revision");

    const Reply preview = c.call(Json{{"type", "model.sync"}, {"revision", ++c.revision_}, {"document", doc}, {"purpose", "preview"},
                                      {"previewFeatures", Json::array({"f2"})}});
    CHECK(preview.header["purpose"] == "preview");
    CHECK(preview.header["bodies"][0]["preview"] == true);
}

TEST_CASE("model.sync: step problems") {
    Client c;
    const Reply zero = c.sync(document(rectangle(3), "oneSide", 0));
    CHECK(zero.header["outcome"] == "error");
    CHECK(zero.header["steps"][1]["problem"]["code"] == "extrude_zero_distance");
    CHECK(zero.header["bodies"].empty());

    const Reply missing = c.sync(document(rectangle(3), "oneSide", 10, "l1,l2,l9"));
    CHECK(missing.header["steps"][1]["problem"]["code"] == "profile_not_found");

    Json open = rectangle(3);
    open["lines"].erase(3);
    open["constraints"].erase(3);
    const Reply noRegion = c.sync(document(open));
    CHECK(noRegion.header["steps"][1]["problem"]["code"] == "profile_open");

    Json conflict = rectangle(3);
    conflict["constraints"].push_back(dimension("d3", "distance", {"l3"}, mm(50)));
    const Reply upstream = c.sync(document(conflict));
    CHECK(upstream.header["steps"][0]["state"] == "error");
    CHECK(upstream.header["steps"][0]["problem"]["code"] == "sketch_conflicting");
    CHECK(upstream.header["steps"][1]["problem"]["code"] == "upstream_failed");
}

TEST_CASE("model.sync: malformed and newer documents") {
    Client c;
    Json doc = document(rectangle(3));
    doc["timeline"][0]["sketch"]["points"][1]["x"] = "a";
    const Reply bad = c.sync(doc);
    CHECK(bad.header["code"] == "bad_document");
    CHECK(bad.header["message"].get<std::string>().find("document.timeline[0].sketch.points[1].x") != std::string::npos);

    Json wrongUnit = document(rectangle(3));
    wrongUnit["timeline"][1]["distance"]["unit"] = "deg";
    CHECK(c.sync(wrongUnit).header["code"] == "bad_document");

    Json twice = document(rectangle(3));
    twice["timeline"][1]["id"] = "f1";
    CHECK(c.sync(twice).header["code"] == "bad_document");

    Json newer = document(rectangle(3));
    newer["format"] = 2;
    newer["timeline"][0]["somethingNew"] = true;
    const Reply r = c.sync(newer);
    CHECK(r.header["code"] == "unsupported_document");

    const Reply bad2 = c.call(Json{{"type", "model.sync"}, {"revision", 0}, {"document", document(rectangle(3))}, {"purpose", "commit"}});
    CHECK(bad2.header["code"] == "bad_message");
}

TEST_CASE("naturalLess sorts curve ids by number") {
    CHECK(model::naturalLess("l6", "l10"));
    CHECK_FALSE(model::naturalLess("l10", "l6"));
    CHECK(model::naturalLess("c1", "l1"));
}

// ---------------------------------------------------------------------------------------------------- test plan 6.1

namespace {

Json t02(int step) {
    Json s{{"points", Json::array({point("P1", 0, 0), point("P2", 20, 1), point("P3", 19, 12), point("P4", 1, 10)})},
           {"lines", Json::array({line("L1", "P1", "P2"), line("L2", "P2", "P3"), line("L3", "P3", "P4"), line("L4", "P4", "P1")})},
           {"circles", Json::array()},
           {"constraints", Json::array()}};
    auto& c = s["constraints"];
    if (step >= 1) {
        c.push_back(constraint("c1", "horizontal", {"L1"}));
        c.push_back(constraint("c2", "horizontal", {"L3"}));
    }
    if (step >= 2) {
        c.push_back(constraint("c3", "vertical", {"L2"}));
        c.push_back(constraint("c4", "vertical", {"L4"}));
    }
    if (step >= 3) c.push_back(dimension("c5", "distance", {"L1"}, mm(20)));
    if (step >= 4) c.push_back(dimension("c6", "distance", {"L2"}, mm(10)));
    if (step >= 5) c.push_back(constraint("c7", "fix", {"P1"}));
    if (step == 6) c.push_back(dimension("c8", "distance", {"L3"}, mm(20)));
    if (step == 7) c.push_back(dimension("c9", "distance", {"L3"}, mm(25)));
    return s;
}

model::ProfileResult regionsOf(const Json& sketchJson, sketch::Sketch& solved) {
    protocol::SketchData data;
    protocol::read(sketchJson, data, "test", "sketch");
    const auto r = sketch::solve(model::toSketch(data, "sketch"));
    REQUIRE(r.status == sketch::SolveStatus::Solved);
    solved = r.geometry;
    return model::findRegions(solved);
}

std::vector<std::string> keys(const Reply& r) {
    std::vector<std::string> k;
    for (const auto& region : r.header["profiles"]) k.push_back(region["key"].get<std::string>());
    return k;
}

} // namespace

TEST_CASE("T02: rectangle step by step, DOF 8 6 4 3 2 0, then redundant and contradicting length") {
    Client c;
    const int dof[] = {8, 6, 4, 3, 2, 0};
    for (int step = 0; step <= 5; ++step) {
        const Reply r = c.solve(t02(step));
        INFO("step " << step);
        CHECK(r.header["status"] == "solved");
        CHECK(r.header["dof"] == dof[step]);
    }
    const Reply redundant = c.solve(t02(6));
    CHECK(redundant.header["status"] == "redundant");
    CHECK(redundant.header["problem"]["code"] == "sketch_redundant");
    CHECK_FALSE(redundant.header["redundant"].empty());
    const Reply conflict = c.solve(t02(7));
    CHECK(conflict.header["status"] == "conflicting");
    const auto ids = conflict.header["conflicting"].get<std::vector<std::string>>();
    CHECK(std::find(ids.begin(), ids.end(), "c9") != ids.end());
    const std::set<std::string> involved{"c1", "c2", "c3", "c4", "c5", "c6", "c7", "c9"};
    for (const auto& id : ids) CHECK(involved.count(id) == 1);
    CHECK(conflict.header["entities"]["L3"] == "over");
}

TEST_CASE("C03: an impossible triangle is not solved, and the problem says so") {
    Client c;
    Json s{{"points", Json::array({point("P1", 0, 0), point("P2", 3.2, 0.2), point("P3", 0.5, 4.1)})},
           {"lines", Json::array({line("L12", "P1", "P2"), line("L23", "P2", "P3"), line("L31", "P3", "P1")})},
           {"circles", Json::array()},
           {"constraints", Json::array({constraint("c0", "fix", {"P1"}), dimension("c1", "distance", {"L12"}, mm(3)),
                                        dimension("c2", "distance", {"L23"}, mm(4)), dimension("c3", "distance", {"L31"}, mm(10))})}};
    const Reply r = c.solve(s);
    INFO(r.header.dump());
    CHECK(r.header["status"] != "solved");
    REQUIRE(r.header.contains("problem"));
    const std::string code = r.header["problem"]["code"].get<std::string>();
    // planegcs names no constraint here (solver test C03); a name list would be reported as a conflict instead.
    CHECK((r.header["conflicting"].empty() ? code == "sketch_unsolvable" : code == "sketch_conflicting"));
    CHECK(pointOf(r, "P2")["x"] == 3.2);
}

TEST_CASE("repeatability: the same under-defined sketch six times gives bit-identical positions") {
    std::string first;
    for (int i = 0; i < 6; ++i) {
        Client c;  // also across engine instances
        const std::string points = c.solve(rectangle(1)).header["points"].dump();
        if (i == 0) first = points;
        CHECK(points == first);
    }
}

TEST_CASE("profiles: separate rectangles, loose lines, three nested levels, coincident points, split regions") {
    Client c;
    const Json withProfiles{{"profiles", true}};
    // Two separate rectangles: two regions.
    Json two = rectangle(0);
    for (const auto& [p, x, y] : {std::tuple{"q1", 100.0, 0.0}, std::tuple{"q2", 120.0, 0.0}, std::tuple{"q3", 120.0, 10.0}, std::tuple{"q4", 100.0, 10.0}})
        two["points"].push_back(point(p, x, y));
    for (const auto& [l, a, b] : {std::tuple{"m1", "q1", "q2"}, std::tuple{"m2", "q2", "q3"}, std::tuple{"m3", "q3", "q4"}, std::tuple{"m4", "q4", "q1"}})
        two["lines"].push_back(line(l, a, b));
    CHECK(keys(c.solve(two, withProfiles)) == std::vector<std::string>{"l1,l2,l3,l4", "m1,m2,m3,m4"});

    // A loose line hanging off a corner, continued by a second one: ignored.
    Json loose = rectangle(0);
    loose["points"].push_back(point("x1", 80, 50));
    loose["points"].push_back(point("x2", 90, 60));
    loose["lines"].push_back(line("t1", "p3", "x1"));
    loose["lines"].push_back(line("t2", "x1", "x2"));
    CHECK(keys(c.solve(loose, withProfiles)) == std::vector<std::string>{"l1,l2,l3,l4"});

    // Three levels: frame, circle in it, smaller circle in that circle.
    Json nested = rectangle(0);
    nested["points"].push_back(point("m", 30, 20));
    nested["circles"].push_back(circle("c1", "m", 15));
    nested["circles"].push_back(circle("c2", "m", 5));
    CHECK(keys(c.solve(nested, withProfiles)) == std::vector<std::string>{"c1|c2", "c2", "l1,l2,l3,l4|c1"});

    // Corners joined by coincident constraints instead of shared points.
    Json joined{{"points", Json::array({point("a1", 0, 0), point("a2", 10, 0), point("b1", 10, 0), point("b2", 0, 10), point("e1", 0, 10),
                                        point("e2", 0, 0)})},
                {"lines", Json::array({line("n1", "a1", "a2"), line("n2", "b1", "b2"), line("n3", "e1", "e2")})},
                {"circles", Json::array()},
                {"constraints", Json::array({constraint("k1", "coincident", {"a2", "b1"}), constraint("k2", "coincident", {"b2", "e1"}),
                                             constraint("k3", "coincident", {"e2", "a1"})})}};
    const Reply triangle = c.solve(joined, withProfiles);
    REQUIRE(keys(triangle) == std::vector<std::string>{"n1,n2,n3"});
    CHECK(triangle.header["profiles"][0]["area"].get<double>() == doctest::Approx(50.0).epsilon(1e-12));

    // A line across the rectangle (sharing points on both long sides) splits it: the old key is gone.
    Json split = rectangle(0);
    split["points"].push_back(point("s1", 30, 0));
    split["points"].push_back(point("s2", 30, 40));
    split["lines"] = Json::array({line("l1", "p1", "s1"), line("l5", "s1", "p2"), line("l2", "p2", "p3"), line("l3", "p3", "s2"),
                                  line("l6", "s2", "p4"), line("l4", "p4", "p1"), line("l7", "s1", "s2")});
    CHECK(keys(c.solve(split, withProfiles)) == std::vector<std::string>{"l1,l4,l6,l7", "l2,l3,l5,l7"});
}

TEST_CASE("profiles: region area from the sketch matches the area of the kernel face") {
    sketch::Sketch solved;
    Json s = rectangle(3);
    s["points"].push_back(point("pc", 20, 20));
    s["circles"].push_back(circle("c1", "pc", 5));
    s["constraints"].push_back(constraint("k6", "fix", {"pc"}));
    s["constraints"].push_back(dimension("d3", "radius", {"c1"}, mm(5)));
    const auto profiles = regionsOf(s, solved);
    REQUIRE(profiles.regions.size() == 2);
    for (const auto& region : profiles.regions) {
        const auto face = model::buildProfileFace(region, solved, model::Frame{{0, 0, 0}, {1, 0, 0}, {0, 1, 0}, {0, 0, 1}});
        GProp_GProps props;
        BRepGProp::SurfaceProperties(face.face, props);
        INFO(region.key);
        CHECK(props.Mass() == doctest::Approx(region.area).epsilon(1e-9));
    }
}

TEST_CASE("names follow the geometry: after a width change f2:side:l2 is the face over the new place of l2") {
    Client c;
    for (const double width : {40.0, 60.0}) {
        const Reply r = c.sync(document(rectangle(3, width)));
        REQUIRE(r.header["outcome"] == "ok");
        const Json& body = r.header["bodies"][0];
        const auto pos = buffer<float>(r, body["mesh"]["positions"]);
        const auto idx = buffer<std::uint32_t>(r, body["mesh"]["indices"]);
        int found = 0;
        for (const auto& face : body["faces"]) {
            if (face["name"] != "f2:side:l2") continue;
            ++found;
            double x = 0;
            const auto start = face["triangleStart"].get<std::size_t>();
            const auto count = face["triangleCount"].get<std::size_t>();
            for (std::size_t t = start; t < start + count; ++t)
                for (std::size_t k = 0; k < 3; ++k) x += pos[3 * idx[3 * t + k]];
            CHECK(x / static_cast<double>(3 * count) == doctest::Approx(width).epsilon(1e-6));
        }
        CHECK(found == 1);
    }
}

TEST_CASE("model.sync stops between two steps when cancelled") {
    model::Model m;
    protocol::ModelSyncCommand command;
    protocol::parse(Json{{"revision", 1}, {"document", document(rectangle(3))}, {"purpose", "commit"}}, command);
    int polls = 0;
    const CancelCheck cancelAfterFirstStep = [&polls] { return ++polls > 1; };
    bool cancelled = false;
    try {
        (void)m.sync(command, cancelAfterFirstStep);
    } catch (const EngineError& e) {
        cancelled = e.code() == "cancelled";
        CHECK(std::string(e.what()).find("revision 1") != std::string::npos);
    }
    CHECK(cancelled);
    const auto answer = m.sync(command, [] { return false; });
    CHECK(answer.message.outcome == "ok");
}

// ---------------------------------------------------------------------------------------------------- B7: profiles in sketch mode, dragging

namespace {

// The rectangle (steps 3: fully determined) with a circle in it; with `circleState` 0 the circle is free, 1 its
// centre is fixed, 2 its radius is given as well.
Json rectangleWithCircle(int rectangleSteps, int circleState) {
    Json s = rectangle(rectangleSteps);
    s["points"].push_back(point("pc", 20, 20));
    s["circles"].push_back(circle("c1", "pc", 5));
    if (circleState >= 1) s["constraints"].push_back(constraint("k6", "fix", {"pc"}));
    if (circleState >= 2) s["constraints"].push_back(dimension("d3", "radius", {"c1"}, mm(5)));
    return s;
}

const Json& regionOf(const Reply& r, const std::string& key) {
    for (const auto& region : r.header["profiles"])
        if (region["key"] == key) return region;
    FAIL("region " << key << " missing");
    static const Json none;
    return none;
}

double signedArea(const std::vector<float>& xy) {
    double a = 0.0;
    const std::size_t n = xy.size() / 2;
    for (std::size_t i = 0; i < n; ++i) {
        const std::size_t j = (i + 1) % n;
        a += static_cast<double>(xy[2 * i]) * xy[2 * j + 1] - static_cast<double>(xy[2 * j]) * xy[2 * i + 1];
    }
    return a / 2.0;
}

Json dragOf(std::initializer_list<std::tuple<std::string, double, double>> targets) {
    Json points = Json::array();
    for (const auto& [id, x, y] : targets) points.push_back(Json{{"id", id}, {"x", x}, {"y", y}});
    return Json{{"points", points}};
}

double dist(const Reply& r, const std::string& a, const std::string& b) {
    const Json pa = pointOf(r, a), pb = pointOf(r, b);
    return std::hypot(pa["x"].get<double>() - pb["x"].get<double>(), pa["y"].get<double>() - pb["y"].get<double>());
}

} // namespace

TEST_CASE("profiles: every region says whether all its curves are determined, and flips with the last dimension") {
    Client c;
    const Json asked{{"profiles", true}};
    // Rectangle without the corner on the origin: the sizes are given, the position is not.
    const Reply loose = c.solve(rectangle(2), asked);
    REQUIRE(loose.header["profiles"].size() == 1);
    CHECK(loose.header["profiles"][0]["determined"] == false);
    // The last constraint (corner on the origin) determines it.
    const Reply done = c.solve(rectangle(3), asked);
    CHECK(done.header["profiles"][0]["determined"] == true);

    // Circle in the frame: the frame region has the circle as a hole and is determined only when the hole is, too.
    for (const auto& [state, circleDetermined, frameDetermined] : {std::tuple{0, false, false}, std::tuple{1, false, false}, std::tuple{2, true, true}}) {
        INFO("circle state " << state);
        const Reply r = c.solve(rectangleWithCircle(3, state), asked);
        REQUIRE(r.header["status"] == "solved");
        CHECK(regionOf(r, "c1")["determined"] == circleDetermined);
        CHECK(regionOf(r, "l1,l2,l3,l4|c1")["determined"] == frameDetermined);
    }
    // The circle determined, the frame not: the circle region is determined, the frame (outer loop) is not.
    const Reply mixed = c.solve(rectangleWithCircle(2, 2), asked);
    CHECK(regionOf(mixed, "c1")["determined"] == true);
    CHECK(regionOf(mixed, "l1,l2,l3,l4|c1")["determined"] == false);
    // Without the element states nothing is known.
    const Reply blind = c.solve(rectangle(3), Json{{"profiles", true}, {"diagnose", false}});
    CHECK(blind.header["profiles"][0]["determined"] == false);
}

TEST_CASE("profiles: loops are closed outlines, outer counter-clockwise first, holes clockwise, circles cut like the fill") {
    Client c;
    const Reply r = c.solve(rectangleWithCircle(3, 2), Json{{"profiles", true}});
    REQUIRE(r.header["status"] == "solved");
    const Json& frame = regionOf(r, "l1,l2,l3,l4|c1");
    REQUIRE(frame["loops"].size() == 2);
    const auto outer = buffer<float>(r, frame["loops"][0]);
    REQUIRE(outer.size() == 8);  // four corners, the first not repeated
    CHECK(signedArea(outer) == doctest::Approx(2400.0).epsilon(1e-6));
    const std::set<std::pair<float, float>> corners{{0.0f, 0.0f}, {60.0f, 0.0f}, {60.0f, 40.0f}, {0.0f, 40.0f}};
    std::set<std::pair<float, float>> found;
    for (std::size_t i = 0; i < outer.size(); i += 2) found.insert({outer[i], outer[i + 1]});
    CHECK(found == corners);

    const auto hole = buffer<float>(r, frame["loops"][1]);
    REQUIRE(hole.size() >= 2 * 8);
    CHECK(signedArea(hole) < 0.0);  // clockwise
    CHECK(std::abs(signedArea(hole)) == doctest::Approx(std::numbers::pi * 25.0).epsilon(0.01));
    for (std::size_t i = 0; i < hole.size(); i += 2) CHECK(std::hypot(hole[i] - 20.0, hole[i + 1] - 20.0) == doctest::Approx(5.0).epsilon(1e-5));

    // The disc: one loop, counter-clockwise, and every outline point is a corner point of the fill triangles.
    const Json& disc = regionOf(r, "c1");
    REQUIRE(disc["loops"].size() == 1);
    const auto ring = buffer<float>(r, disc["loops"][0]);
    CHECK(signedArea(ring) > 0.0);
    CHECK(ring.size() == hole.size());
    const auto uv = buffer<float>(r, disc["fill"]["positions"]);
    std::set<std::pair<float, float>> nodes;
    for (std::size_t i = 0; i < uv.size(); i += 2) nodes.insert({uv[i], uv[i + 1]});
    for (std::size_t i = 0; i < ring.size(); i += 2) CHECK(nodes.count({ring[i], ring[i + 1]}) == 1);
    // Every loop buffer is aligned like the others.
    for (const auto& region : r.header["profiles"])
        for (const auto& ref : region["loops"]) CHECK(ref["offset"].get<std::size_t>() % protocol::kPayloadAlignment == 0);
}

TEST_CASE("drag: a free corner follows the target and the constraints keep holding") {
    Client c;
    // Horizontal and vertical lines only: the corner p3 can go anywhere, p2 and p4 follow it.
    const Reply r = c.solve(rectangle(1), Json{{"drag", dragOf({{"p3", 70.0, 55.0}})}});
    REQUIRE(r.header["status"] == "solved");
    REQUIRE(r.header.contains("drag"));
    CHECK(r.header["drag"]["complete"] == true);
    CHECK(r.header["drag"]["points"][0]["id"] == "p3");
    CHECK(r.header["drag"]["points"][0]["moved"] == true);
    CHECK(r.header["drag"]["points"][0]["error"].get<double>() < 1e-6);
    CHECK(pointOf(r, "p3")["x"].get<double>() == doctest::Approx(70.0).epsilon(1e-7));
    CHECK(pointOf(r, "p3")["y"].get<double>() == doctest::Approx(55.0).epsilon(1e-7));
    // l2 (p2 - p3) is vertical, l3 (p3 - p4) horizontal, l1 (p1 - p2) horizontal, l4 (p4 - p1) vertical: still holds.
    CHECK(pointOf(r, "p2")["x"].get<double>() == doctest::Approx(70.0).epsilon(1e-7));
    CHECK(pointOf(r, "p4")["y"].get<double>() == doctest::Approx(55.0).epsilon(1e-7));
    CHECK(pointOf(r, "p1")["x"].get<double>() == doctest::Approx(pointOf(r, "p4")["x"].get<double>()).epsilon(1e-9));
    CHECK(pointOf(r, "p1")["y"].get<double>() == doctest::Approx(pointOf(r, "p2")["y"].get<double>()).epsilon(1e-9));
    // The states of the diagnosis come with it (default diagnose true) and so does the degree of freedom.
    CHECK(r.header["dof"] == 4);
    CHECK(r.header["entities"]["p3"] == "under");
}

TEST_CASE("drag: a long way is cut into short steps and still arrives") {
    Client c;
    const Reply r = c.solve(rectangle(1), Json{{"drag", dragOf({{"p3", 260.0, 190.0}})}});
    REQUIRE(r.header["status"] == "solved");
    CHECK(r.header["drag"]["steps"].get<int>() > 20);
    CHECK(r.header["drag"]["complete"] == true);
    CHECK(r.header["drag"]["points"][0]["error"].get<double>() < 1e-6);
    CHECK(pointOf(r, "p3")["x"].get<double>() == doctest::Approx(260.0).epsilon(1e-7));
}

TEST_CASE("drag: a rectangle with sizes moves as a whole and keeps its sizes") {
    Client c;
    const Reply r = c.solve(rectangle(2), Json{{"drag", dragOf({{"p3", 100.0, 80.0}})}});
    REQUIRE(r.header["status"] == "solved");
    CHECK(r.header["drag"]["points"][0]["error"].get<double>() < 1e-6);
    CHECK(dist(r, "p1", "p2") == doctest::Approx(60.0).epsilon(1e-7));
    CHECK(dist(r, "p2", "p3") == doctest::Approx(40.0).epsilon(1e-7));
    CHECK(pointOf(r, "p3")["x"].get<double>() == doctest::Approx(100.0).epsilon(1e-6));
    CHECK(r.header["dof"] == 2);
}

TEST_CASE("drag: a fully determined point does not move, and the answer says so") {
    Client c;
    const Reply before = c.solve(rectangle(3));
    // Send the solved rectangle back with a target: nothing may move.
    Json solved = rectangle(3);
    for (auto& p : solved["points"]) {
        const Json q = pointOf(before, p["id"].get<std::string>());
        p["x"] = q["x"];
        p["y"] = q["y"];
    }
    const Reply r = c.solve(solved, Json{{"drag", dragOf({{"p3", 100.0, 100.0}})}});
    REQUIRE(r.header["status"] == "solved");
    CHECK(r.header["dof"] == 0);
    CHECK(r.header["drag"]["points"][0]["moved"] == false);
    CHECK(r.header["drag"]["points"][0]["error"].get<double>() > 50.0);
    CHECK(r.header["drag"]["complete"] == true);
    for (const auto& id : {"p1", "p2", "p3", "p4"}) {
        CHECK(pointOf(r, id)["x"].get<double>() == doctest::Approx(pointOf(before, id)["x"].get<double>()).epsilon(1e-9));
        CHECK(pointOf(r, id)["y"].get<double>() == doctest::Approx(pointOf(before, id)["y"].get<double>()).epsilon(1e-9));
    }
}

TEST_CASE("drag: a point that is only partly free goes as near as the constraints allow") {
    Client c;
    // One vertical line from a fixed point: its end can slide along y but not away in x.
    Json s{{"points", Json::array({point("a", 10, 0), point("b", 10, 20)})},
           {"lines", Json::array({line("l1", "a", "b")})},
           {"circles", Json::array()},
           {"constraints", Json::array({constraint("k1", "fix", {"a"}), constraint("k2", "vertical", {"l1"})})}};
    const Reply r = c.solve(s, Json{{"drag", dragOf({{"b", 40.0, 35.0}})}});
    REQUIRE(r.header["status"] == "solved");
    CHECK(pointOf(r, "b")["x"].get<double>() == doctest::Approx(10.0).epsilon(1e-9));
    CHECK(pointOf(r, "b")["y"].get<double>() == doctest::Approx(35.0).epsilon(1e-6));
    CHECK(r.header["drag"]["points"][0]["moved"] == true);
    CHECK(r.header["drag"]["points"][0]["error"].get<double>() == doctest::Approx(30.0).epsilon(1e-6));
}

TEST_CASE("drag: several points, a conflicting sketch and bad requests") {
    Client c;
    // Two points at once: both reach their targets when nothing holds them.
    const Reply two = c.solve(rectangle(0), Json{{"drag", dragOf({{"p1", -5.0, -5.0}, {"p3", 70.0, 50.0}})}});
    REQUIRE(two.header["status"] == "solved");
    CHECK(pointOf(two, "p1")["x"].get<double>() == doctest::Approx(-5.0).epsilon(1e-7));
    CHECK(pointOf(two, "p3")["y"].get<double>() == doctest::Approx(50.0).epsilon(1e-7));
    CHECK(two.header["drag"]["points"].size() == 2);

    // A conflicting sketch is not dragged: the answer names the conflict and the geometry stays as sent.
    Json conflict = rectangle(3);
    conflict["constraints"].push_back(dimension("d3", "distance", {"l3"}, mm(50)));
    const Reply bad = c.solve(conflict, Json{{"drag", dragOf({{"p3", 70.0, 50.0}})}});
    CHECK(bad.header["status"] == "conflicting");
    CHECK(pointOf(bad, "p3")["x"].get<double>() == doctest::Approx(59.0));
    CHECK(bad.header["drag"]["points"][0]["moved"] == false);

    const auto refused = [&](const Json& drag) {
        const Reply r = c.solve(rectangle(1), Json{{"drag", drag}});
        CHECK(r.header["type"] == "error");
        CHECK(r.header["code"] == "bad_message");
        return r.header["message"].get<std::string>();
    };
    CHECK(refused(dragOf({{"nope", 1.0, 1.0}})).find("drag.points[0].id") != std::string::npos);
    CHECK(refused(dragOf({{"p1", 1.0, 1.0}, {"p1", 2.0, 2.0}})).find("drag.points[1].id") != std::string::npos);
    CHECK(refused(Json{{"points", Json::array()}}).find("drag.points") != std::string::npos);
    CHECK(refused(Json{{"points", Json::array({Json{{"id", "p1"}, {"x", "left"}, {"y", 1}}})}}).find("drag.points[0].x") != std::string::npos);
}

TEST_CASE("drag: profiles and element states come with the dragged sketch") {
    Client c;
    const Reply r = c.solve(rectangleWithCircle(2, 2), Json{{"profiles", true}, {"drag", dragOf({{"p3", 65.0, 45.0}})}});
    REQUIRE(r.header["status"] == "solved");
    CHECK(keys(r) == std::vector<std::string>{"c1", "l1,l2,l3,l4|c1"});  // the circle stays inside after the move
    CHECK(regionOf(r, "c1")["determined"] == true);
    CHECK(regionOf(r, "l1,l2,l3,l4|c1")["determined"] == false);  // the rectangle is still free to move
    CHECK(regionOf(r, "c1")["loops"].size() == 1);
}

TEST_CASE("drag: 100 steps along a path with a chain of 40 links keep every link length (P04)") {
    Client c;
    constexpr int links = 40;
    constexpr double length = 5.0;
    Json s{{"points", Json::array()}, {"lines", Json::array()}, {"circles", Json::array()}, {"constraints", Json::array()}};
    for (int i = 0; i <= links; ++i) s["points"].push_back(point("q" + std::to_string(i), i * length, 0.0));
    for (int i = 0; i < links; ++i) {
        s["lines"].push_back(line("m" + std::to_string(i), "q" + std::to_string(i), "q" + std::to_string(i + 1)));
        s["constraints"].push_back(dimension("e" + std::to_string(i), "distance", {"m" + std::to_string(i)}, mm(length)));
    }
    s["constraints"].push_back(constraint("kf", "fix", {"q0"}));
    double worstLength = 0.0, worstSolveMs = 0.0;
    std::vector<double> times;
    for (int step = 1; step <= 100; ++step) {
        const double angle = 0.9 * std::numbers::pi * step / 100.0;
        const double radius = 150.0;  // the chain is 200 mm long; the pointer stays inside its reach
        const Reply r = c.solve(s, Json{{"drag", dragOf({{"q" + std::to_string(links), radius * std::cos(angle), radius * std::sin(angle)}})}, {"diagnose", false}});
        INFO("step " << step << ": " << r.header.dump().substr(0, 300));
        REQUIRE(r.header["status"] == "solved");
        CHECK(r.header["drag"]["complete"] == true);
        for (int i = 0; i <= links; ++i) {
            const Json p = pointOf(r, "q" + std::to_string(i));
            s["points"][static_cast<std::size_t>(i)]["x"] = p["x"];
            s["points"][static_cast<std::size_t>(i)]["y"] = p["y"];
        }
        for (int i = 0; i < links; ++i) worstLength = std::max(worstLength, std::abs(dist(r, "q" + std::to_string(i), "q" + std::to_string(i + 1)) - length));
        worstSolveMs = std::max(worstSolveMs, r.header["timeMs"].get<double>());
        times.push_back(r.header["timeMs"].get<double>());
        if (step == 100) CHECK(r.header["drag"]["points"][0]["error"].get<double>() < 1e-4);
    }
    CHECK(worstLength < 1e-6);
    std::sort(times.begin(), times.end());
    MESSAGE("worst link length deviation " << worstLength << " mm, median step " << times[50] << " ms, slowest step " << worstSolveMs << " ms");
}

TEST_CASE("drag: the engine keeps nothing, so a cancelled drag needs no call: the original sketch answers as before") {
    Client c;
    const Json original = rectangle(1);
    const Reply before = c.solve(original, Json{{"profiles", true}});
    (void)c.solve(original, Json{{"profiles", true}, {"drag", dragOf({{"p3", 90.0, 70.0}})}});
    const Reply after = c.solve(original, Json{{"profiles", true}});
    CHECK(before.header["points"].dump() == after.header["points"].dump());
    CHECK(before.payload == after.payload);
}

// ---- distances to what was clicked, and the angle between two rays ----

namespace {

Json withReverse(Json d, bool first, bool second) {
    d["reverse"] = Json::array({first, second});
    return d;
}

double circleRadius(const Reply& r, const std::string& id) {
    for (const auto& c : r.header["circles"])
        if (c["id"] == id) return c["radius"].get<double>();
    FAIL("no circle " << id);
    return 0.0;
}

}  // namespace

TEST_CASE("point, line and circle distances measure what was clicked (reference dimensions)") {
    Client c;
    Json s{{"points", Json::array({point("a", 0, 0), point("b", 10, 0), point("c", 0, 5), point("d", 10, 5), point("p", 3, 4), point("o1", 0, 20),
                                   point("o2", 20, 20), point("o3", 50, 0), point("o4", 53, 0)})},
           {"lines", Json::array({line("m1", "a", "b"), line("m2", "c", "d")})},
           {"circles", Json::array({circle("c1", "o1", 3), circle("c2", "o2", 2), circle("c3", "o3", 10), circle("c4", "o4", 2)})},
           {"constraints", Json::array({dimension("r1", "distance", {"p", "m1"}, mm(1), false),   // point to line
                                        dimension("r1b", "distance", {"m1", "p"}, mm(1), false),  // the same, clicked the other way round
                                        dimension("r2", "distance", {"m1", "m2"}, mm(1), false),  // two parallel lines
                                        dimension("r3", "distance", {"p", "c1"}, mm(1), false),   // point to a rim
                                        dimension("r3b", "distance", {"c1", "p"}, mm(1), false),
                                        dimension("r4", "distance", {"c1", "m1"}, mm(1), false),  // rim to line
                                        dimension("r4b", "distance", {"m1", "c1"}, mm(1), false),
                                        dimension("r5", "distance", {"c1", "c2"}, mm(1), false),  // rim to rim, outside each other
                                        dimension("r6", "distance", {"c3", "c4"}, mm(1), false),  // rim to rim, one inside the other
                                        dimension("r7", "distance", {"o1", "m1"}, mm(1), false),  // from the centre: a point of the sketch
                                        dimension("r8", "distance", {"o1", "o2"}, mm(1), false)})}};
    const Reply r = c.solve(s);
    INFO(r.header.dump());
    REQUIRE(r.header["status"] == "solved");
    const auto& ref = r.header["reference"];
    CHECK(ref["r1"].get<double>() == doctest::Approx(4.0).epsilon(1e-12));
    CHECK(ref["r1b"].get<double>() == doctest::Approx(4.0).epsilon(1e-12));
    CHECK(ref["r2"].get<double>() == doctest::Approx(5.0).epsilon(1e-12));
    CHECK(ref["r3"].get<double>() == doctest::Approx(std::hypot(3.0, 16.0) - 3.0).epsilon(1e-12));
    CHECK(ref["r3b"].get<double>() == doctest::Approx(std::hypot(3.0, 16.0) - 3.0).epsilon(1e-12));
    CHECK(ref["r4"].get<double>() == doctest::Approx(17.0).epsilon(1e-12));
    CHECK(ref["r4b"].get<double>() == doctest::Approx(17.0).epsilon(1e-12));
    CHECK(ref["r5"].get<double>() == doctest::Approx(15.0).epsilon(1e-12));
    CHECK(ref["r6"].get<double>() == doctest::Approx(5.0).epsilon(1e-12));  // 10 - (2 + 3)
    CHECK(ref["r7"].get<double>() == doctest::Approx(20.0).epsilon(1e-12));
    CHECK(ref["r8"].get<double>() == doctest::Approx(20.0).epsilon(1e-12));
}

TEST_CASE("driving distances move the geometry to the value, on the branch the sketch is on") {
    Client c;
    const auto base = [] {
        return Json{{"points", Json::array({point("a", 0, 0), point("b", 10, 0), point("p", 3, 4), point("o", 14, 0)})},
                    {"lines", Json::array({line("m1", "a", "b")})},
                    {"circles", Json::array({circle("c1", "o", 2)})},
                    {"constraints", Json::array({constraint("fa", "fix", {"a"}), constraint("fb", "fix", {"b"}), constraint("fo", "fix", {"o"}),
                                                 dimension("rad1", "radius", {"c1"}, mm(2))})}};
    };
    {  // point to line: p ends 7 mm above the line, its x stays free
        Json s = base();
        s["constraints"].push_back(dimension("d", "distance", {"p", "m1"}, mm(7)));
        const Reply r = c.solve(s);
        REQUIRE(r.header["status"] == "solved");
        CHECK(pointOf(r, "p")["y"].get<double>() == doctest::Approx(7.0).epsilon(1e-9));
    }
    {  // point to rim: p is outside the circle (centre (14, 0), radius 2) and ends 3 mm from the rim = 5 mm from the centre
        Json s = base();
        s["constraints"].push_back(dimension("d", "distance", {"p", "c1"}, mm(3)));
        const Reply r = c.solve(s);
        REQUIRE(r.header["status"] == "solved");
        const Json p = pointOf(r, "p");
        CHECK(std::hypot(p["x"].get<double>() - 14.0, p["y"].get<double>()) == doctest::Approx(5.0).epsilon(1e-9));
    }
    {  // rim to rim: the second circle (radius 2) ends 4 mm from the first rim = 8 mm between the centres
        Json s = base();
        s["points"].push_back(point("q", 30, 0));
        s["circles"].push_back(circle("c2", "q", 2));
        s["constraints"].push_back(dimension("rad2", "radius", {"c2"}, mm(2)));
        s["constraints"].push_back(dimension("d", "distance", {"c1", "c2"}, mm(4)));
        const Reply r = c.solve(s);
        REQUIRE(r.header["status"] == "solved");
        const Json q = pointOf(r, "q");
        CHECK(std::hypot(q["x"].get<double>() - 14.0, q["y"].get<double>()) == doctest::Approx(2.0 + 2.0 + 4.0).epsilon(1e-9));
        CHECK(circleRadius(r, "c2") == doctest::Approx(2.0));
    }
    {  // rim to line: the circle (radius 2) is 3 mm from the line, so its centre is 5 mm from it
        Json s = base();
        s["points"].push_back(point("m", 5, 9));
        s["circles"].push_back(circle("c3", "m", 2));
        s["constraints"].push_back(dimension("rad3", "radius", {"c3"}, mm(2)));
        s["constraints"].push_back(dimension("d", "distance", {"c3", "m1"}, mm(3)));
        const Reply r = c.solve(s);
        REQUIRE(r.header["status"] == "solved");
        CHECK(pointOf(r, "m")["y"].get<double>() == doctest::Approx(5.0).epsilon(1e-9));
    }
    {  // two lines: the second line's start point ends 6 mm from the first line; the same dimension twice is redundant
        Json s = base();
        s["points"].push_back(point("e", 0, 4));
        s["points"].push_back(point("f", 10, 4));
        s["lines"].push_back(line("m2", "e", "f"));
        s["constraints"].push_back(constraint("h2", "horizontal", {"m2"}));  // parallel to the first line, so the value is their distance
        s["constraints"].push_back(dimension("d", "distance", {"m1", "m2"}, mm(6)));
        const Reply r = c.solve(s);
        REQUIRE(r.header["status"] == "solved");
        CHECK(pointOf(r, "e")["y"].get<double>() == doctest::Approx(6.0).epsilon(1e-9));
        s["constraints"].push_back(dimension("d2", "distance", {"m1", "m2"}, mm(6)));
        CHECK(c.solve(s).header["status"] == "redundant");
    }
}

TEST_CASE("wrong references for a distance are named, a driving distance of 0 is refused") {
    Client c;
    Json s{{"points", Json::array({point("a", 0, 0), point("b", 10, 0), point("p", 3, 4)})},
           {"lines", Json::array({line("m1", "a", "b")})},
           {"circles", Json::array()},
           {"constraints", Json::array({dimension("d", "distance", {"p"}, mm(5))})}};
    const Reply one = c.solve(s);
    CHECK(one.header["code"] == "bad_document");
    CHECK(one.header["message"].get<std::string>().find("with one reference needs a line") != std::string::npos);
    s["constraints"] = Json::array({dimension("d", "distance", {"p", "nothing"}, mm(5))});
    const Reply two = c.solve(s);
    CHECK(two.header["code"] == "bad_document");
    CHECK(two.header["message"].get<std::string>().find("needs two of point, line and circle") != std::string::npos);
    s["constraints"] = Json::array({dimension("d", "distance", {"p", "m1"}, mm(0))});
    CHECK(c.solve(s).header["code"] == "bad_document");
}

TEST_CASE("the angle between two rays picks one of the four sectors, driving and as a reference") {
    Client c;
    // l1 runs a -> b (east); l4 runs d -> a, so its direction points away from d. d sits at 53.13 degrees above a: the rays
    // east / towards d enclose 53.13, east / away from d enclose 126.87, and so on round the crossing.
    const auto corner = [](Json angle) {
        return Json{{"points", Json::array({point("a", 0, 0), point("b", 10, 0), point("d", 3, 4)})},
                    {"lines", Json::array({line("l1", "a", "b"), line("l4", "d", "a")})},
                    {"circles", Json::array()},
                    {"constraints", Json::array({constraint("fa", "fix", {"a"}), constraint("fb", "fix", {"b"}), std::move(angle)})}};
    };
    const double acute = std::atan2(4.0, 3.0) * 180.0 / std::numbers::pi;  // 53.13
    const auto reference = [&](bool first, bool second) {
        return c.solve(corner(withReverse(dimension("r", "angle", {"l1", "l4"}, deg(1), false), first, second))).header["reference"]["r"].get<double>();
    };
    CHECK(reference(false, true) == doctest::Approx(acute).epsilon(1e-9));          // east, towards d
    CHECK(reference(false, false) == doctest::Approx(180.0 - acute).epsilon(1e-9));  // east, away from d
    CHECK(reference(true, false) == doctest::Approx(acute).epsilon(1e-9));          // west, away from d
    CHECK(reference(true, true) == doctest::Approx(180.0 - acute).epsilon(1e-9));    // west, towards d
    // The references the other way round measure the same sector (the sign of the turn does not show: 0 to 180).
    CHECK(c.solve(corner(withReverse(dimension("r", "angle", {"l4", "l1"}, deg(1), false), true, false))).header["reference"]["r"].get<double>() ==
          doctest::Approx(acute).epsilon(1e-9));
    // Without the flags the two directions give a signed angle, as before.
    CHECK(c.solve(corner(dimension("r", "angle", {"l1", "l4"}, deg(1), false))).header["reference"]["r"].get<double>() ==
          doctest::Approx(acute - 180.0).epsilon(1e-9));

    // Driving: the corner becomes 60 degrees, d swings round a onto the 60 degree ray.
    const Reply solved = c.solve(corner(withReverse(dimension("k", "angle", {"l1", "l4"}, deg(60)), false, true)));
    INFO(solved.header.dump());
    REQUIRE(solved.header["status"] == "solved");
    const Json d = pointOf(solved, "d");
    CHECK(std::atan2(d["y"].get<double>(), d["x"].get<double>()) * 180.0 / std::numbers::pi == doctest::Approx(60.0).epsilon(1e-9));

    // The sector is a property of the lines: the same sketch turned by 25 degrees, or with d on the other side of l1 (the
    // ray towards d is then below the line), still measures the corner between east and towards d.
    const double t = 25.0 * std::numbers::pi / 180.0;
    Json turned = corner(withReverse(dimension("r", "angle", {"l1", "l4"}, deg(1), false), false, true));
    turned["constraints"] = Json::array({turned["constraints"][2]});
    for (auto& p : turned["points"]) {
        const double x = p["x"].get<double>(), y = p["y"].get<double>();
        p["x"] = x * std::cos(t) - y * std::sin(t);
        p["y"] = x * std::sin(t) + y * std::cos(t);
    }
    CHECK(c.solve(turned).header["reference"]["r"].get<double>() == doctest::Approx(acute).epsilon(1e-9));
    Json below = corner(withReverse(dimension("r", "angle", {"l1", "l4"}, deg(1), false), false, true));
    below["constraints"] = Json::array({below["constraints"][2]});
    below["points"][2]["y"] = -4.0;
    CHECK(c.solve(below).header["reference"]["r"].get<double>() == doctest::Approx(acute).epsilon(1e-9));
}

TEST_CASE("reverse flags are checked: two flags, angles only, a value from 0 to 180") {
    Client c;
    Json s{{"points", Json::array({point("a", 0, 0), point("b", 10, 0), point("d", 0, 8)})},
           {"lines", Json::array({line("l1", "a", "b"), line("l4", "d", "a")})},
           {"circles", Json::array()},
           {"constraints", Json::array()}};
    Json one = dimension("k", "angle", {"l1", "l4"}, deg(60));
    one["reverse"] = Json::array({true});
    s["constraints"] = Json::array({one});
    const Reply shortList = c.solve(s);
    CHECK(shortList.header["code"] == "bad_document");
    CHECK(shortList.header["message"].get<std::string>().find("needs two flags") != std::string::npos);

    s["constraints"] = Json::array({withReverse(dimension("k", "distance", {"l1"}, mm(5)), false, false)});
    CHECK(c.solve(s).header["code"] == "bad_document");

    s["constraints"] = Json::array({withReverse(dimension("k", "angle", {"l1", "l4"}, deg(200)), false, true)});
    const Reply tooBig = c.solve(s);
    CHECK(tooBig.header["code"] == "bad_document");
    CHECK(tooBig.header["message"].get<std::string>().find("0 to 180 degrees") != std::string::npos);
}

// ---- what is still free, in facts (the palette's "what is still missing") ----

namespace {

std::vector<std::string> factKinds(const Reply& r) {
    std::vector<std::string> out;
    for (const auto& f : r.header["freedom"]) out.push_back(f["kind"].get<std::string>() + (f["kind"] == "position" ? std::to_string(f["moves"].get<int>()) : ""));
    return out;
}

const Json* factOf(const Reply& r, const std::string& kind, const std::string& element = "") {
    for (const auto& f : r.header["freedom"]) {
        if (f["kind"] != kind) continue;
        if (element.empty()) return &f;
        for (const auto& e : f["elements"])
            if (e == element) return &f;
    }
    return nullptr;
}

}  // namespace

TEST_CASE("freedom: a free rectangle can be moved as a whole and has no width or height; one statement, not eight") {
    Client c;
    const Reply r = c.solve(rectangle(1), Json{{"diagnose", true}});
    INFO(r.header["freedom"].dump());
    REQUIRE(r.header["status"] == "solved");
    CHECK(r.header["dof"] == 4);
    CHECK(factKinds(r) == std::vector<std::string>{"position2", "length", "length"});
    const Json* move = factOf(r, "position");
    REQUIRE(move != nullptr);
    CHECK((*move)["shape"] == "rectangle");
    CHECK((*move)["elements"] == Json::array({"l1", "l2", "l3", "l4"}));
    // Bottom and top change length together (the width), left and right too (the height).
    CHECK(r.header["freedom"][1]["elements"] == Json::array({"l1", "l3"}));
    CHECK(r.header["freedom"][2]["elements"] == Json::array({"l2", "l4"}));
}

TEST_CASE("freedom: the owner's rectangle - both sizes dimensioned, not at the origin - can only be moved") {
    Client c;
    const Reply r = c.solve(rectangle(2), Json{{"diagnose", true}});
    REQUIRE(r.header["status"] == "solved");
    CHECK(r.header["dof"] == 2);
    CHECK(factKinds(r) == std::vector<std::string>{"position2"});
    CHECK(r.header["freedom"][0]["shape"] == "rectangle");
}

TEST_CASE("freedom: a rectangle on the origin without sizes has a width and a height to give, and cannot be moved") {
    Client c;
    Json s = rectangle(1);
    s["constraints"].push_back(constraint("k5", "coincident", {"p1", "@origin"}));
    const Reply r = c.solve(s, Json{{"diagnose", true}});
    CHECK(r.header["dof"] == 2);
    CHECK(factKinds(r) == std::vector<std::string>{"length", "length"});
}

TEST_CASE("freedom: a fully defined rectangle has nothing free; a sketch with no diagnosis or with a drag lists nothing") {
    Client c;
    const Reply full = c.solve(rectangle(3), Json{{"diagnose", true}});
    CHECK(full.header["dof"] == 0);
    CHECK(full.header["freedom"].empty());
    CHECK(c.solve(rectangle(1), Json{{"diagnose", false}}).header["freedom"].empty());
    const Json drag{{"points", Json::array({Json{{"id", "p3"}, {"x", 70.0}, {"y", 50.0}}})}};
    const Reply dragged = c.solve(rectangle(1), Json{{"diagnose", true}, {"drag", drag}});
    CHECK(dragged.header["freedom"].empty());
}

TEST_CASE("freedom: circles - the radius of a circle without a diameter, and a circle that can slide along a line") {
    Client c;
    Json s{{"points", Json::array({point("o", 10, 10)})},
           {"lines", Json::array()},
           {"circles", Json::array({circle("c1", "o", 5)})},
           {"constraints", Json::array({constraint("k1", "fix", {"o"})})}};
    const Reply radius = c.solve(s, Json{{"diagnose", true}});
    CHECK(factKinds(radius) == std::vector<std::string>{"radius"});
    CHECK(radius.header["freedom"][0]["shape"] == "circle");
    CHECK(radius.header["freedom"][0]["elements"] == Json::array({"c1"}));

    // The diameter given and the centre free: the circle can be moved anywhere.
    s["constraints"] = Json::array({dimension("d1", "diameter", {"c1"}, mm(10))});
    const Reply moved = c.solve(s, Json{{"diagnose", true}});
    CHECK(factKinds(moved) == std::vector<std::string>{"position2"});
    CHECK(moved.header["freedom"][0]["shape"] == "circle");

    // The centre on the x axis: only along one direction.
    s["constraints"].push_back(constraint("k2", "pointOnCurve", {"o", "@axisU"}));
    const Reply slide = c.solve(s, Json{{"diagnose", true}});
    CHECK(factKinds(slide) == std::vector<std::string>{"position1"});
}

TEST_CASE("freedom: lines - a free line moves, turns and has a length; fixed at one end it only turns and stretches") {
    Client c;
    Json s{{"points", Json::array({point("a", 5, 5), point("b", 30, 12)})},
           {"lines", Json::array({line("l1", "a", "b")})},
           {"circles", Json::array()},
           {"constraints", Json::array()}};
    const Reply freeLine = c.solve(s, Json{{"diagnose", true}});
    CHECK(freeLine.header["dof"] == 4);
    CHECK(factKinds(freeLine) == std::vector<std::string>{"position2", "rotation", "length"});
    CHECK(freeLine.header["freedom"][0]["shape"] == "line");

    s["constraints"] = Json::array({constraint("k1", "coincident", {"a", "@origin"}), dimension("d1", "distance", {"l1"}, mm(25))});
    const Reply turns = c.solve(s, Json{{"diagnose", true}});
    CHECK(factKinds(turns) == std::vector<std::string>{"rotation"});

    s["constraints"] = Json::array({constraint("k1", "coincident", {"a", "@origin"}), constraint("k2", "horizontal", {"l1"})});
    const Reply stretches = c.solve(s, Json{{"diagnose", true}});
    CHECK(factKinds(stretches) == std::vector<std::string>{"length"});
}

TEST_CASE("freedom: a corner of a triangle that can move against the rest is a direction and a length, not a point") {
    Client c;
    Json s{{"points", Json::array({point("a", 0, 0), point("b", 40, 0), point("d", 15, 25)})},
           {"lines", Json::array({line("l1", "a", "b"), line("l2", "b", "d"), line("l3", "d", "a")})},
           {"circles", Json::array()},
           {"constraints", Json::array({constraint("k1", "coincident", {"a", "@origin"}), constraint("k2", "horizontal", {"l1"}),
                                        dimension("d1", "distance", {"l1"}, mm(40))})}};
    const Reply r = c.solve(s, Json{{"diagnose", true}});
    CHECK(r.header["dof"] == 2);  // the third corner is free
    INFO(r.header["freedom"].dump());
    CHECK(factOf(r, "length", "l2") != nullptr);
    CHECK(factOf(r, "direction", "l2") != nullptr);
    CHECK(factOf(r, "point") == nullptr);
    CHECK(factOf(r, "position") == nullptr);
}
