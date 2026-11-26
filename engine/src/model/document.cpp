#include "model/document.hpp"

#include "core/errors.hpp"

#include <map>
#include <numbers>
#include <set>
#include <type_traits>
#include <variant>

namespace hc::model {

namespace err = protocol::err;

namespace {

[[noreturn]] void bad(const std::string& message) { throw EngineError(err::kBadDocument, message); }

std::string at(const std::string& path, std::size_t i) { return path + "[" + std::to_string(i) + "]"; }

protocol::Vec3 vec(Vec3d v) {
    protocol::Vec3 r;
    r.x = v.x;
    r.y = v.y;
    r.z = v.z;
    return r;
}

// Kind of an element id inside one sketch (fixed references included).
enum class Kind { None, Point, Line, Circle };

Kind kindOf(const sketch::Sketch& s, const std::string& id) {
    if (s.isPoint(id)) return Kind::Point;
    if (s.isLine(id)) return Kind::Line;
    if (s.circle(id)) return Kind::Circle;
    return Kind::None;
}

const char* kindName(Kind k) {
    switch (k) {
    case Kind::Point: return "a point";
    case Kind::Line: return "a line";
    case Kind::Circle: return "a circle";
    case Kind::None: return "nothing";
    }
    return "nothing";
}

double lengthValue(const protocol::Quantity& q, const std::string& where) {
    if (q.unit != "mm") bad(where + " is a length and needs the unit mm, got " + q.unit + ".");
    return q.value;
}

double angleValue(const protocol::Quantity& q, const std::string& where) {
    if (q.unit != "deg") bad(where + " is an angle and needs the unit deg, got " + q.unit + ".");
    return q.value * std::numbers::pi / 180.0;
}

} // namespace

Frame frameOf(const protocol::PlaneRef& plane) {
    const auto& p = std::get<protocol::OriginPlaneRef>(plane);
    if (p.plane == "xz") return {{0, 0, 0}, {1, 0, 0}, {0, 0, 1}, {0, -1, 0}};
    if (p.plane == "yz") return {{0, 0, 0}, {0, 1, 0}, {0, 0, 1}, {1, 0, 0}};
    return {{0, 0, 0}, {1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
}

protocol::PlaneFrame toProtocol(const Frame& f) {
    protocol::PlaneFrame r;
    r.origin = vec(f.origin);
    r.u = vec(f.u);
    r.v = vec(f.v);
    r.normal = vec(f.normal);
    return r;
}

sketch::Sketch toSketch(const protocol::SketchData& data, const std::string& path) {
    using T = sketch::ConstraintType;
    sketch::Sketch s;
    for (const auto& p : data.points) s.points.push_back({p.id, p.x, p.y, false});
    for (const auto& l : data.lines) s.lines.push_back({l.id, l.p1, l.p2, l.construction});
    for (const auto& c : data.circles) s.circles.push_back({c.id, c.center, c.radius, c.construction});

    for (std::size_t i = 0; i < data.constraints.size(); ++i) {
        const std::string where = at(path + ".constraints", i);
        sketch::Constraint c;
        if (const auto* g = std::get_if<protocol::GeometricConstraint>(&data.constraints[i])) {
            c.id = g->id;
            c.refs = g->refs;
            const std::string& k = g->kind;
            const std::string label = where + " (" + g->id + ", " + k + ")";
            const auto refKind = [&](std::size_t n) {
                if (c.refs.size() <= n) bad(label + " needs " + std::to_string(n + 1) + " references, got " + std::to_string(c.refs.size()) + ".");
                return kindOf(s, c.refs[n]);
            };
            if (k == "coincident") c.type = T::Coincident;
            else if (k == "horizontal") c.type = T::Horizontal;
            else if (k == "vertical") c.type = T::Vertical;
            else if (k == "parallel") c.type = T::Parallel;
            else if (k == "perpendicular") c.type = T::Perpendicular;
            else if (k == "fix") c.type = T::Fix;
            else if (k == "pointOnCurve") {
                const Kind curve = refKind(1);
                if (curve == Kind::Line) c.type = T::PointOnLine;
                else if (curve == Kind::Circle) c.type = T::PointOnCircle;
                else bad(label + " needs a line or a circle as reference 2, got \"" + c.refs[1] + "\" (" + kindName(curve) + ").");
            } else if (k == "equal") {
                const Kind a = refKind(0);
                const Kind b = refKind(1);
                if (a == Kind::Line && b == Kind::Line) c.type = T::EqualLength;
                else if (a == Kind::Circle && b == Kind::Circle) c.type = T::EqualRadius;
                else bad(label + " needs two lines or two circles, got " + kindName(a) + " (\"" + c.refs[0] + "\") and " + kindName(b) + " (\"" + c.refs[1] + "\").");
            } else {
                bad(label + " has the unknown kind \"" + k + "\".");
            }
        } else {
            const auto& d = std::get<protocol::Dimension>(data.constraints[i]);
            c.id = d.id;
            c.refs = d.refs;
            c.driving = d.driving;
            const std::string& k = d.kind;
            const std::string value = where + ".value (" + d.id + ", " + k + ")";
            if (k == "distance") {
                c.value = lengthValue(d.value, value);
                const std::string label = where + " (" + d.id + ", distance)";
                if (c.refs.size() == 1) {
                    c.type = T::Distance;
                    if (kindOf(s, c.refs[0]) != Kind::Line) bad(label + " with one reference needs a line, got \"" + c.refs[0] + "\".");
                } else if (c.refs.size() == 2) {
                    // What was clicked is what is measured: a circle as reference is its rim, its centre is a point.
                    const Kind a = kindOf(s, c.refs[0]);
                    const Kind b = kindOf(s, c.refs[1]);
                    const auto order = [&] { std::swap(c.refs[0], c.refs[1]); };  // the engine wants the point or circle first
                    if (a == Kind::Point && b == Kind::Point) c.type = T::Distance;
                    else if (a == Kind::Point && b == Kind::Line) c.type = T::DistancePointLine;
                    else if (a == Kind::Line && b == Kind::Point) { c.type = T::DistancePointLine; order(); }
                    else if (a == Kind::Line && b == Kind::Line) c.type = T::DistanceLineLine;
                    else if (a == Kind::Point && b == Kind::Circle) c.type = T::DistancePointCircle;
                    else if (a == Kind::Circle && b == Kind::Point) { c.type = T::DistancePointCircle; order(); }
                    else if (a == Kind::Circle && b == Kind::Line) c.type = T::DistanceCircleLine;
                    else if (a == Kind::Line && b == Kind::Circle) { c.type = T::DistanceCircleLine; order(); }
                    else if (a == Kind::Circle && b == Kind::Circle) c.type = T::DistanceCircleCircle;
                    else
                        bad(label + " needs two of point, line and circle, got " + kindName(a) + " (\"" + c.refs[0] + "\") and " + kindName(b) + " (\"" +
                            c.refs[1] + "\").");
                } else {
                    bad(label + " needs one reference (a line) or two (point, line or circle), got " + std::to_string(c.refs.size()) + ".");
                }
            } else if (k == "distanceX") {
                c.type = T::DistanceX;
                c.value = lengthValue(d.value, value);
            } else if (k == "distanceY") {
                c.type = T::DistanceY;
                c.value = lengthValue(d.value, value);
            } else if (k == "angle") {
                c.type = T::LineLineAngle;
                c.value = angleValue(d.value, value);
                if (d.reverse) {
                    // The angle between two rays, one along each line, reversed where the flag says so.
                    if (d.reverse->size() != 2)
                        bad(where + ".reverse (" + d.id + ", angle) needs two flags, one per reference, got " + std::to_string(d.reverse->size()) + ".");
                    c.rays = true;
                    c.reverse1 = (*d.reverse)[0];
                    c.reverse2 = (*d.reverse)[1];
                }
            } else if (k == "diameter") {
                c.type = T::Diameter;
                c.value = lengthValue(d.value, value);
            } else if (k == "radius") {
                c.type = T::Radius;
                c.value = lengthValue(d.value, value);
            } else {
                bad(where + " (" + d.id + ") has the unknown kind \"" + k + "\".");
            }
            if (d.reverse && k != "angle") bad(where + ".reverse (" + d.id + ", " + k + ") belongs to angle dimensions only.");
            if ((c.type == T::Diameter || c.type == T::Radius) && !c.refs.empty() && kindOf(s, c.refs[0]) != Kind::Circle)
                bad(where + " (" + d.id + ", " + k + ") needs a circle, got \"" + c.refs[0] + "\".");
        }
        s.constraints.push_back(std::move(c));
    }
    return s;
}

void checkDocument(const protocol::HalfCubeDocument& doc) {
    if (doc.format > protocol::kDocumentFormat)
        throw EngineError(err::kUnsupportedDocument, "The document has the format version " + std::to_string(doc.format) +
                                                         "; this engine reads format " + std::to_string(protocol::kDocumentFormat) +
                                                         " and older. Update HalfCube to open it.");
    std::set<std::string> ids;
    const auto claim = [&ids](const std::string& id, const std::string& where) {
        if (id.empty()) bad(where + " has an empty id.");
        if (!ids.insert(id).second) bad(where + " uses the id \"" + id + "\", which is already used elsewhere in the document.");
    };
    std::set<std::string> components;
    for (std::size_t i = 0; i < doc.components.size(); ++i) {
        const auto& c = doc.components[i];
        claim(c.id, at("document.components", i));
        components.insert(c.id);
    }
    if (!components.count("root")) bad("document.components has no component \"root\"; every document has its top component root.");

    // body id -> creating step, from the component lists
    std::map<std::string, std::string> bodies;
    for (std::size_t i = 0; i < doc.components.size(); ++i)
        for (std::size_t j = 0; j < doc.components[i].bodies.size(); ++j) {
            const auto& b = doc.components[i].bodies[j];
            claim(b.id, at(at("document.components", i) + ".bodies", j));
            bodies[b.id] = b.createdBy;
        }

    std::set<std::string> sketchesSoFar;
    std::set<std::string> createdBodies;
    for (std::size_t i = 0; i < doc.timeline.size(); ++i) {
        const std::string where = at("document.timeline", i);
        std::visit(
            [&](const auto& f) {
                claim(f.id, where);
                if (!components.count(f.component)) bad(where + " (" + f.id + ") belongs to the unknown component \"" + f.component + "\".");
                using F = std::decay_t<decltype(f)>;
                if constexpr (std::is_same_v<F, protocol::SketchFeature>) {
                    for (const auto& p : f.sketch.points) claim(p.id, where + ".sketch.points");
                    for (const auto& l : f.sketch.lines) claim(l.id, where + ".sketch.lines");
                    for (const auto& c : f.sketch.circles) claim(c.id, where + ".sketch.circles");
                    for (const auto& k : f.sketch.constraints) std::visit([&](const auto& x) { claim(x.id, where + ".sketch.constraints"); }, k);
                    sketchesSoFar.insert(f.id);
                } else {
                    if (!sketchesSoFar.count(f.profile.sketch))
                        bad(where + ".profile.sketch (" + f.id + ") refers to \"" + f.profile.sketch + "\", which is no sketch earlier in the timeline.");
                    lengthValue(f.distance, where + ".distance (" + f.id + ")");
                    const auto b = bodies.find(f.body);
                    if (b == bodies.end()) bad(where + ".body (" + f.id + ") names the body \"" + f.body + "\", which no component lists.");
                    if (b->second != f.id)
                        bad(where + ".body (" + f.id + "): the body \"" + f.body + "\" is listed as created by \"" + b->second + "\".");
                    if (!createdBodies.insert(f.body).second) bad(where + ".body (" + f.id + "): the body \"" + f.body + "\" is created twice.");
                }
            },
            doc.timeline[i]);
    }
    for (const auto& [body, creator] : bodies)
        if (!createdBodies.count(body))
            bad("document.components lists the body \"" + body + "\" as created by \"" + creator + "\", but no extrusion in the timeline creates it.");
}

} // namespace hc::model
