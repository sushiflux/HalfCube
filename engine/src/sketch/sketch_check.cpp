#include "sketch/sketch_check.hpp"

#include "sketch/sketch_solver.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace hc::sketch {

namespace {

struct Vec {
    double x = 0.0, y = 0.0;
};

Vec operator-(Vec a, Vec b) { return {a.x - b.x, a.y - b.y}; }
double dot(Vec a, Vec b) { return a.x * b.x + a.y * b.y; }
double cross(Vec a, Vec b) { return a.x * b.y - a.y * b.x; }
double length(Vec a) { return std::hypot(a.x, a.y); }

const std::string& ref(const Constraint& c, std::size_t i) {
    if (c.refs.size() <= i)
        throw SketchError("Constraint \"" + c.id + "\" (" + nameOf(c.type) + ") needs " + std::to_string(i + 1) + " references.");
    return c.refs[i];
}

Vec pointAt(const Sketch& s, const std::string& id, const Constraint& c) {
    if (id == kOrigin) return {0.0, 0.0};
    const Point* p = s.point(id);
    if (!p) throw SketchError("Constraint \"" + c.id + "\" refers to \"" + id + "\", which is no point of the sketch.");
    return {p->x, p->y};
}

struct Segment {
    Vec a, b;
};

Segment lineAt(const Sketch& s, const std::string& id, const Constraint& c) {
    if (id == kAxisU) return {{0.0, 0.0}, {1.0, 0.0}};
    if (id == kAxisV) return {{0.0, 0.0}, {0.0, 1.0}};
    const Line* l = s.line(id);
    if (!l) throw SketchError("Constraint \"" + c.id + "\" refers to \"" + id + "\", which is no line of the sketch.");
    return {pointAt(s, l->p1, c), pointAt(s, l->p2, c)};
}

struct Round {
    Vec center;
    double radius = 0.0;
};

Round roundAt(const Sketch& s, const std::string& id, const Constraint& c) {
    if (const Circle* ci = s.circle(id)) return {pointAt(s, ci->center, c), ci->radius};
    if (const Arc* a = s.arc(id)) return {pointAt(s, a->center, c), a->radius};
    throw SketchError("Constraint \"" + c.id + "\" refers to \"" + id + "\", which is no circle or arc of the sketch.");
}

double distanceToLine(Vec p, const Segment& l) {
    const Vec d = l.b - l.a;
    const double len = length(d);
    if (len == 0.0) return length(p - l.a);
    return std::abs(cross(d, p - l.a)) / len;
}

double wrapAngle(double a) {
    while (a > std::numbers::pi) a -= 2.0 * std::numbers::pi;
    while (a <= -std::numbers::pi) a += 2.0 * std::numbers::pi;
    return a;
}

double directionResidual(const Segment& l1, const Segment& l2, bool parallel) {
    const Vec u = l1.b - l1.a, v = l2.b - l2.a;
    const double n = length(u) * length(v);
    if (n == 0.0) return 0.0;
    return parallel ? std::abs(cross(u, v)) / n : std::abs(dot(u, v)) / n;
}

// Counter-clockwise angle from the direction of l1 to the direction of l2, in (-pi, pi].
double angleBetween(const Segment& l1, const Segment& l2) {
    const Vec u = l1.b - l1.a, v = l2.b - l2.a;
    return std::atan2(cross(u, v), dot(u, v));
}

// Gap between the rims of two circles as planegcs measures it: circles outside each other (every centre outside the other circle)
// give the distance between the rims, which is negative when they cross; with a centre inside the other circle it is the room
// between the smaller circle and the bigger one's rim.
double rimGap(const Round& a, const Round& b) {
    const double d = length(a.center - b.center);
    if (d >= a.radius && d >= b.radius) return d - (a.radius + b.radius);
    const Round& big = a.radius >= b.radius ? a : b;
    const Round& small = a.radius >= b.radius ? b : a;
    return big.radius - (small.radius + d);
}

} // namespace

double measure(const Sketch& s, const Constraint& c) {
    switch (c.type) {
    case ConstraintType::Distance:
        if (c.refs.size() == 1) {
            const Segment l = lineAt(s, ref(c, 0), c);
            return length(l.b - l.a);
        }
        return length(pointAt(s, ref(c, 1), c) - pointAt(s, ref(c, 0), c));
    case ConstraintType::DistanceX: return pointAt(s, ref(c, 1), c).x - pointAt(s, ref(c, 0), c).x;
    case ConstraintType::DistanceY: return pointAt(s, ref(c, 1), c).y - pointAt(s, ref(c, 0), c).y;
    case ConstraintType::LineLineAngle: {
        // Between rays: undo the half turn a reversed ray adds to the angle of the directions.
        const double directions = angleBetween(lineAt(s, ref(c, 0), c), lineAt(s, ref(c, 1), c));
        return c.rays && c.reverse1 != c.reverse2 ? wrapAngle(directions - std::numbers::pi) : directions;
    }
    case ConstraintType::DistancePointLine: return distanceToLine(pointAt(s, ref(c, 0), c), lineAt(s, ref(c, 1), c));
    case ConstraintType::DistanceLineLine: {
        const Segment first = lineAt(s, ref(c, 0), c);
        return distanceToLine(first.a, lineAt(s, ref(c, 1), c));
    }
    case ConstraintType::DistancePointCircle: {
        const Round round = roundAt(s, ref(c, 1), c);
        return std::abs(length(pointAt(s, ref(c, 0), c) - round.center) - round.radius);
    }
    case ConstraintType::DistanceCircleLine: {
        const Round round = roundAt(s, ref(c, 0), c);
        return std::abs(distanceToLine(round.center, lineAt(s, ref(c, 1), c)) - round.radius);
    }
    case ConstraintType::DistanceCircleCircle: return rimGap(roundAt(s, ref(c, 0), c), roundAt(s, ref(c, 1), c));
    case ConstraintType::LineAngle: {
        const Segment l = lineAt(s, ref(c, 0), c);
        return std::atan2(l.b.y - l.a.y, l.b.x - l.a.x);
    }
    case ConstraintType::Radius: return roundAt(s, ref(c, 0), c).radius;
    // A diameter is twice the radius parameter (FreeCAD reports it the same way).
    case ConstraintType::Diameter: return 2.0 * roundAt(s, ref(c, 0), c).radius;
    default:
        throw SketchError("Constraint \"" + c.id + "\" (" + nameOf(c.type) + ") has no value to measure; only dimensions can be "
                          "reference dimensions.");
    }
}

ResidualReport checkConstraints(const Sketch& s) {
    ResidualReport report;
    const auto record = [&report](const std::string& key, double r) {
        report.residuals[key] = r;
        if (r > report.maxResidual || report.worst.empty()) {
            if (r >= report.maxResidual) {
                report.maxResidual = r;
                report.worst = key;
            }
        }
    };
    for (const Constraint& c : s.constraints) {
        if (!c.driving) continue;
        double r = 0.0;
        switch (c.type) {
        case ConstraintType::Coincident: r = length(pointAt(s, ref(c, 0), c) - pointAt(s, ref(c, 1), c)); break;
        case ConstraintType::Horizontal: {
            const Segment l = lineAt(s, ref(c, 0), c);
            r = std::abs(l.b.y - l.a.y);
            break;
        }
        case ConstraintType::Vertical: {
            const Segment l = lineAt(s, ref(c, 0), c);
            r = std::abs(l.b.x - l.a.x);
            break;
        }
        case ConstraintType::Parallel: r = directionResidual(lineAt(s, ref(c, 0), c), lineAt(s, ref(c, 1), c), true); break;
        case ConstraintType::Perpendicular: r = directionResidual(lineAt(s, ref(c, 0), c), lineAt(s, ref(c, 1), c), false); break;
        case ConstraintType::Tangent: {
            const Round round = roundAt(s, ref(c, 1), c);
            r = std::abs(distanceToLine(round.center, lineAt(s, ref(c, 0), c)) - round.radius);
            break;
        }
        case ConstraintType::PointOnLine: r = distanceToLine(pointAt(s, ref(c, 0), c), lineAt(s, ref(c, 1), c)); break;
        case ConstraintType::PointOnCircle: {
            const Round round = roundAt(s, ref(c, 1), c);
            r = std::abs(length(pointAt(s, ref(c, 0), c) - round.center) - round.radius);
            break;
        }
        case ConstraintType::EqualLength: {
            const Segment a = lineAt(s, ref(c, 0), c), b = lineAt(s, ref(c, 1), c);
            r = std::abs(length(a.b - a.a) - length(b.b - b.a));
            break;
        }
        case ConstraintType::EqualRadius: r = std::abs(roundAt(s, ref(c, 0), c).radius - roundAt(s, ref(c, 1), c).radius); break;
        // A fixing holds the position the sketch had before solving; the solved sketch alone cannot tell it.
        case ConstraintType::Fix: continue;
        case ConstraintType::LineAngle:
        case ConstraintType::LineLineAngle: r = std::abs(wrapAngle(measure(s, c) - c.value)); break;
        case ConstraintType::DistanceX:
        case ConstraintType::DistanceY:
        case ConstraintType::Distance:
        case ConstraintType::DistancePointLine:
        case ConstraintType::DistanceLineLine:
        case ConstraintType::DistancePointCircle:
        case ConstraintType::DistanceCircleLine:
        case ConstraintType::DistanceCircleCircle:
        case ConstraintType::Radius:
        case ConstraintType::Diameter: r = std::abs(measure(s, c) - c.value); break;
        }
        record(c.id, r);
    }
    for (const Arc& a : s.arcs) {
        const Constraint ctx{"arc " + a.id, ConstraintType::Radius, {a.id}, 0.0, true};
        const Vec center = pointAt(s, a.center, ctx);
        const double r = std::max(std::abs(length(pointAt(s, a.start, ctx) - center) - a.radius),
                                  std::abs(length(pointAt(s, a.end, ctx) - center) - a.radius));
        record("arc " + a.id, r);
    }
    return report;
}

} // namespace hc::sketch
