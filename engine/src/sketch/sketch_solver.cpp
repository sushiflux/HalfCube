#include "sketch/sketch_solver.hpp"

#include "sketch/sketch_check.hpp"

#include <GCS.h>

#include <Eigen/Core>
#include <boost/version.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <numbers>
#include <set>
#include <stdexcept>

namespace pc::sketch {

namespace {

using Clock = std::chrono::steady_clock;

// Every solver parameter of one planegcs system, in one block whose size is fixed before the first parameter is
// added (see the header for why). Adding past the counted size is a programming error: a reallocation would
// invalidate every pointer already handed to planegcs.
class ParameterBlock {
public:
    explicit ParameterBlock(std::size_t count) : limit_(count) { values_.reserve(count); }

    double* add(double v) {
        if (values_.size() == limit_)
            throw std::logic_error("sketch solver: more parameters than counted (" + std::to_string(limit_) + ")");
        values_.push_back(v);
        return &values_.back();
    }
    std::size_t size() const { return values_.size(); }
    std::size_t limit() const { return limit_; }

private:
    std::size_t limit_;
    std::vector<double> values_;
};

// Point id where the line and the arc of a tangent constraint meet (an end point of both), or nullptr when they do
// not share an end point.
const std::string* sharedTangentPoint(const Sketch& s, const Constraint& c) {
    if (c.type != ConstraintType::Tangent || c.refs.size() != 2) return nullptr;
    const Line* l = s.line(c.refs[0]);
    const Arc* a = s.arc(c.refs[1]);
    if (!l || !a) return nullptr;
    for (const std::string* p : {&l->p1, &l->p2})
        if (*p == a->start || *p == a->end) return p;
    return nullptr;
}

bool usesReserved(const Sketch& s) {
    for (const Constraint& c : s.constraints)
        if (c.driving)
            for (const std::string& r : c.refs)
                if (isReserved(r)) return true;
    return false;
}

// Constants a fix constraint adds: two coordinates per point, the radius of a circle.
std::size_t fixParameters(const Sketch& s, const Constraint& c) {
    if (c.refs.empty()) return 0;
    if (s.point(c.refs[0])) return 2;
    if (s.line(c.refs[0])) return 4;
    if (s.circle(c.refs[0])) return 3;
    return 0;
}

std::size_t countParameters(const Sketch& s, std::size_t dragTargets) {
    // The drag targets (two constants each) come last, so they never shift the order of the other parameters.
    std::size_t n = (usesReserved(s) ? 6 : 0) + 2 * s.points.size() + s.circles.size() + 3 * s.arcs.size() + 2 * dragTargets;
    for (const Constraint& c : s.constraints) {
        if (!c.driving) continue;
        if (hasValue(c.type)) ++n;
        if (sharedTangentPoint(s, c)) ++n;  // the locked angle (0 or pi) of the tangency at the shared point
        if (c.type == ConstraintType::Fix) n += fixParameters(s, c);
    }
    return n;
}

std::size_t expectedRefs(ConstraintType t) {
    switch (t) {
    case ConstraintType::Horizontal:
    case ConstraintType::Vertical:
    case ConstraintType::LineAngle:
    case ConstraintType::Radius:
    case ConstraintType::Diameter:
    case ConstraintType::Fix: return 1;
    default: return 2;
    }
}

void validate(const Sketch& s) {
    std::set<std::string> ids;
    const auto claim = [&ids](const std::string& id, const char* kind) {
        if (id.empty()) throw SketchError(std::string("A ") + kind + " of the sketch has an empty id.");
        if (isReserved(id)) throw SketchError("The " + std::string(kind) + " id \"" + id + "\" starts with @, which is kept for the fixed references.");
        if (!ids.insert(id).second) throw SketchError("The id \"" + id + "\" is used twice in the sketch.");
    };
    const auto finite = [](double v, const std::string& what) {
        if (!std::isfinite(v)) throw SketchError(what + " is not a finite number.");
    };
    for (const Point& p : s.points) {
        claim(p.id, "point");
        finite(p.x, "The x coordinate of point \"" + p.id + "\"");
        finite(p.y, "The y coordinate of point \"" + p.id + "\"");
    }
    const auto needPoint = [&s](const std::string& id, const std::string& owner) {
        if (!s.point(id)) throw SketchError(owner + " refers to \"" + id + "\", which is no point of the sketch.");
    };
    for (const Line& l : s.lines) {
        claim(l.id, "line");
        needPoint(l.p1, "Line \"" + l.id + "\"");
        needPoint(l.p2, "Line \"" + l.id + "\"");
        if (l.p1 == l.p2) throw SketchError("Line \"" + l.id + "\" starts and ends at the same point \"" + l.p1 + "\".");
    }
    for (const Circle& c : s.circles) {
        claim(c.id, "circle");
        needPoint(c.center, "Circle \"" + c.id + "\"");
        finite(c.radius, "The radius of circle \"" + c.id + "\"");
        if (!(c.radius > 0.0)) throw SketchError("Circle \"" + c.id + "\" needs a radius greater than 0 mm.");
    }
    for (const Arc& a : s.arcs) {
        claim(a.id, "arc");
        needPoint(a.center, "Arc \"" + a.id + "\"");
        needPoint(a.start, "Arc \"" + a.id + "\"");
        needPoint(a.end, "Arc \"" + a.id + "\"");
        if (!(a.radius > 0.0)) throw SketchError("Arc \"" + a.id + "\" needs a radius greater than 0 mm.");
    }
    std::set<std::string> constraintIds;
    for (const Constraint& c : s.constraints) {
        if (c.id.empty()) throw SketchError("A constraint of the sketch has an empty id.");
        if (ids.count(c.id) || !constraintIds.insert(c.id).second) throw SketchError("The id \"" + c.id + "\" is used twice in the sketch.");
        const std::size_t want = expectedRefs(c.type);
        const bool lineLength = c.type == ConstraintType::Distance && c.refs.size() == 1;
        if (c.refs.size() != want && !lineLength)
            throw SketchError("Constraint \"" + c.id + "\" (" + nameOf(c.type) + ") needs " + std::to_string(want) + " references, got " +
                              std::to_string(c.refs.size()) + ".");
        if (std::all_of(c.refs.begin(), c.refs.end(), [](const std::string& r) { return isReserved(r); }))
            throw SketchError("Constraint \"" + c.id + "\" (" + nameOf(c.type) + ") refers only to fixed references (" + c.refs.front() +
                              "); it needs at least one element of the sketch.");
        for (std::size_t i = 0; i < c.refs.size(); ++i)
            if (isReserved(c.refs[i]) && c.refs[i] != kOrigin && c.refs[i] != kAxisU && c.refs[i] != kAxisV)
                throw SketchError("Constraint \"" + c.id + "\" refers to \"" + c.refs[i] + "\"; the fixed references are @origin, @axisU and @axisV.");
        if (hasValue(c.type)) finite(c.value, "The value of constraint \"" + c.id + "\"");
        const bool positive = c.type == ConstraintType::Distance || c.type == ConstraintType::Radius || c.type == ConstraintType::Diameter ||
                              c.type == ConstraintType::DistancePointLine || c.type == ConstraintType::DistanceLineLine ||
                              c.type == ConstraintType::DistancePointCircle || c.type == ConstraintType::DistanceCircleLine ||
                              c.type == ConstraintType::DistanceCircleCircle;
        if (positive && c.driving && !(c.value > 0.0))
            throw SketchError("Dimension \"" + c.id + "\" (" + nameOf(c.type) + ") needs a value greater than 0 mm, got " + std::to_string(c.value) + ".");
        if (c.rays && c.type != ConstraintType::LineLineAngle)
            throw SketchError("Constraint \"" + c.id + "\" (" + nameOf(c.type) + ") has ray directions; only an angle between two lines can have them.");
        if (c.rays && c.driving && !(c.value >= 0.0 && c.value <= std::numbers::pi))
            throw SketchError("Dimension \"" + c.id + "\" (angle) measures between two rays and needs a value from 0 to 180 degrees.");
        if (!c.driving && !hasValue(c.type))
            throw SketchError("Constraint \"" + c.id + "\" (" + nameOf(c.type) + ") cannot be a reference dimension; only dimensions can.");
    }
}

void validateDrag(const Sketch& s, const std::vector<DragTarget>& drag) {
    std::set<std::string> seen;
    for (const DragTarget& d : drag) {
        if (!s.point(d.point)) throw SketchError("The drag target refers to \"" + d.point + "\", which is no point of the sketch.");
        if (!seen.insert(d.point).second) throw SketchError("The point \"" + d.point + "\" is dragged twice.");
        if (!std::isfinite(d.x) || !std::isfinite(d.y)) throw SketchError("The drag target of point \"" + d.point + "\" is not a finite position.");
    }
}

// One planegcs system built from a sketch. Lives only for one solve or diagnosis (or one drag step). dragged: the
// points to pull (never fixed ones: they are no unknowns), each with a temporary constraint to a constant target.
class PlanegcsModel {
public:
    explicit PlanegcsModel(const Sketch& s, const std::vector<DragTarget>& dragged = {})
        : sketch_(s), params_(countParameters(s, dragged.size())) {
        sys.debugMode = GCS::NoDebug;
        if (usesReserved(s)) {
            // Fixed references first, as constants: origin, end of the u axis, end of the v axis.
            GCS::Point origin(constant(0.0), constant(0.0));
            GCS::Point uEnd(constant(1.0), constant(0.0));
            GCS::Point vEnd(constant(0.0), constant(1.0));
            points_[std::string(kOrigin)] = origin;
            GCS::Line u, v;
            u.p1 = origin;
            u.p2 = uEnd;
            v.p1 = origin;
            v.p2 = vEnd;
            lines_[std::string(kAxisU)] = u;
            lines_[std::string(kAxisV)] = v;
        }
        for (const Point& p : s.points) {
            double* x = params_.add(p.x);
            double* y = params_.add(p.y);
            // A fixed point is no unknown (as FreeCAD's FixParameters).
            if (!p.fixed) {
                unknowns_.push_back(x);
                unknowns_.push_back(y);
            }
            points_[p.id] = GCS::Point(x, y);
        }
        for (const Line& l : s.lines) {
            GCS::Line g;
            g.p1 = points_.at(l.p1);
            g.p2 = points_.at(l.p2);
            lines_[l.id] = g;
        }
        for (const Circle& c : s.circles) {
            GCS::Circle g;
            g.center = points_.at(c.center);
            g.rad = unknown(c.radius);
            circles_[c.id] = g;
        }
        for (const Arc& a : s.arcs) {
            // As FreeCAD's Sketch::addArc: start, end and centre points plus radius, start and end angle are
            // parameters, tied together by the arc rules (tag 0). Counter-clockwise: end angle > start angle.
            GCS::Arc g;
            g.center = points_.at(a.center);
            g.start = points_.at(a.start);
            g.end = points_.at(a.end);
            const double cx = *g.center.x, cy = *g.center.y;
            const double startAngle = std::atan2(*g.start.y - cy, *g.start.x - cx);
            double endAngle = std::atan2(*g.end.y - cy, *g.end.x - cx);
            if (endAngle <= startAngle) endAngle += 2.0 * std::numbers::pi;
            g.rad = unknown(a.radius);
            g.startAngle = unknown(startAngle);
            g.endAngle = unknown(endAngle);
            arcs_[a.id] = g;
        }
        for (const Arc& a : s.arcs) sys.addConstraintArcRules(arcs_.at(a.id), 0, true);
        for (std::size_t i = 0; i < s.constraints.size(); ++i) {
            const Constraint& c = s.constraints[i];
            if (!c.driving) continue;  // reference dimensions never reach planegcs
            addConstraint(c, static_cast<int>(i) + 1);
            ++solverConstraints;
        }
        // Temporary constraints of a drag, as FreeCAD's Sketch::initMove: the point is pulled to a constant target in
        // the soft second subsystem (negative tag), which is solved after the real constraints.
        for (const DragTarget& d : dragged) {
            double* tx = constant(d.x);
            double* ty = constant(d.y);
            dragTargets_.emplace_back(tx, ty);
            GCS::Point target(tx, ty);
            sys.addConstraintP2PCoincident(target, points_.at(d.point), GCS::DefaultTemporaryConstraint, true);
        }
        if (params_.size() != params_.limit())
            throw std::logic_error("sketch solver: " + std::to_string(params_.size()) + " parameters created, " +
                                   std::to_string(params_.limit()) + " counted");
        sys.declareUnknowns(unknowns_);
    }

    ~PlanegcsModel() { sys.clear(); }
    PlanegcsModel(const PlanegcsModel&) = delete;
    PlanegcsModel& operator=(const PlanegcsModel&) = delete;

    bool hasUnknowns() const { return !unknowns_.empty(); }

    // Moves the targets of the drag constraints (same order as the dragged points given to the constructor).
    void setDragTarget(std::size_t i, double x, double y) {
        *dragTargets_[i].first = x;
        *dragTargets_[i].second = y;
    }
    std::size_t parameterCount() const { return params_.size(); }

    void readBack(Sketch& out) const {
        for (Point& p : out.points) {
            const GCS::Point& g = points_.at(p.id);
            p.x = *g.x;
            p.y = *g.y;
        }
        for (Circle& c : out.circles) c.radius = *circles_.at(c.id).rad;
        for (Arc& a : out.arcs) a.radius = *arcs_.at(a.id).rad;
    }

    // Constraint ids of planegcs tags in sketch order; tag 0 (arc rules) has no id and is left out.
    std::vector<std::string> idsOfTags(const GCS::VEC_I& tags) const {
        std::set<int> unique(tags.begin(), tags.end());
        std::vector<std::string> ids;
        for (int t : unique)
            if (t >= 1 && static_cast<std::size_t>(t) <= sketch_.constraints.size()) ids.push_back(sketch_.constraints[static_cast<std::size_t>(t) - 1].id);
        return ids;
    }

    void diagnosis(SolveResult& r) const {
        GCS::VEC_I conflicting, redundant, partial;
        sys.getConflicting(conflicting);
        sys.getRedundant(redundant);
        sys.getPartiallyRedundant(partial);
        r.dof = sys.dofsNumber();
        r.conflicting = idsOfTags(conflicting);
        r.redundant = idsOfTags(redundant);
        r.partiallyRedundant = idsOfTags(partial);
    }

    // Which points and radii can still move, from the parameters planegcs names as dependent (as FreeCAD's
    // per-element colouring). A system without any constraint has an empty diagnosis matrix: everything is free.
    void freedom(SolveResult& r) const {
        r.freePoints.clear();
        r.freeRadii.clear();
        r.diagnosed = true;
        const bool all = sys.isEmptyDiagnoseMatrix() || solverConstraints == 0;
        GCS::VEC_pD dependent;
        sys.getDependentParams(dependent);
        const std::set<double*> free(dependent.begin(), dependent.end());
        for (const Point& p : sketch_.points) {
            if (p.fixed) continue;
            const GCS::Point& g = points_.at(p.id);
            if (all || free.count(g.x) || free.count(g.y)) r.freePoints.insert(p.id);
        }
        for (const Circle& c : sketch_.circles)
            if (all || free.count(circles_.at(c.id).rad)) r.freeRadii.insert(c.id);
    }

    std::size_t solverConstraints = 0;

private:
    double* unknown(double v) {
        double* p = params_.add(v);
        unknowns_.push_back(p);
        return p;
    }
    double* constant(double v) { return params_.add(v); }

    std::string refName(const Constraint& c) const {
        return "Constraint \"" + c.id + "\" (" + nameOf(c.type) + ") needs ";
    }
    GCS::Line& L(const Constraint& c, std::size_t i) {
        const auto it = lines_.find(c.refs[i]);
        if (it == lines_.end())
            throw SketchError(refName(c) + "a line as reference " + std::to_string(i + 1) + ", got \"" + c.refs[i] + "\".");
        return it->second;
    }
    GCS::Point& Pt(const Constraint& c, std::size_t i) {
        const auto it = points_.find(c.refs[i]);
        if (it == points_.end())
            throw SketchError(refName(c) + "a point as reference " + std::to_string(i + 1) + ", got \"" + c.refs[i] + "\".");
        return it->second;
    }
    GCS::Circle& C(const Constraint& c, std::size_t i) {
        const auto it = circles_.find(c.refs[i]);
        if (it == circles_.end())
            throw SketchError(refName(c) + "a circle as reference " + std::to_string(i + 1) + ", got \"" + c.refs[i] + "\".");
        return it->second;
    }
    [[noreturn]] void needRound(const Constraint& c, std::size_t i) const {
        throw SketchError("Constraint \"" + c.id + "\" (" + nameOf(c.type) + ") needs a circle or arc as reference " +
                          std::to_string(i + 1) + ", got \"" + c.refs[i] + "\".");
    }

    void fixPoint(GCS::Point& p, int tag) {
        sys.addConstraintCoordinateX(p, constant(*p.x), tag, true);
        sys.addConstraintCoordinateY(p, constant(*p.y), tag, true);
    }

    // Absolute direction of a fixed axis against +u (rad).
    static double axisAngle(const std::string& id) { return id == kAxisV ? std::numbers::pi / 2.0 : 0.0; }

    void addConstraint(const Constraint& c, int tag) {
        switch (c.type) {
        case ConstraintType::Coincident: sys.addConstraintP2PCoincident(Pt(c, 0), Pt(c, 1), tag, true); return;
        case ConstraintType::Horizontal: sys.addConstraintHorizontal(L(c, 0), tag, true); return;
        case ConstraintType::Vertical: sys.addConstraintVertical(L(c, 0), tag, true); return;
        case ConstraintType::Parallel: sys.addConstraintParallel(L(c, 0), L(c, 1), tag, true); return;
        case ConstraintType::Perpendicular: sys.addConstraintPerpendicular(L(c, 0), L(c, 1), tag, true); return;
        case ConstraintType::PointOnLine: sys.addConstraintPointOnLine(Pt(c, 0), L(c, 1), tag, true); return;
        case ConstraintType::PointOnCircle: sys.addConstraintPointOnCircle(Pt(c, 0), C(c, 1), tag, true); return;
        case ConstraintType::EqualLength: sys.addConstraintEqualLength(L(c, 0), L(c, 1), tag, true); return;
        case ConstraintType::EqualRadius: sys.addConstraintEqualRadius(C(c, 0), C(c, 1), tag, true); return;
        case ConstraintType::Fix: {
            // Holds the element where it is now: coordinate constraints with this tag, so a conflict names the fixing.
            const std::string& r = c.refs[0];
            if (auto p = points_.find(r); p != points_.end() && sketch_.point(r)) fixPoint(p->second, tag);
            else if (auto l = lines_.find(r); l != lines_.end() && sketch_.line(r)) {
                fixPoint(l->second.p1, tag);
                fixPoint(l->second.p2, tag);
            } else if (auto ci = circles_.find(r); ci != circles_.end()) {
                fixPoint(ci->second.center, tag);
                sys.addConstraintCircleRadius(ci->second, constant(*ci->second.rad), tag, true);
            } else {
                throw SketchError("Constraint \"" + c.id + "\" (fix) needs a point, line or circle of the sketch, got \"" + r + "\".");
            }
            return;
        }
        case ConstraintType::Tangent: {
            GCS::Line& l = L(c, 0);
            if (const std::string* shared = sharedTangentPoint(sketch_, c)) {
                // Tangency where line and arc end at the same point, as FreeCAD's endpoint-to-endpoint tangency: the
                // angle between both curves at that point is 0 or pi, chosen from the current geometry and then
                // locked. The plain line-circle tangency (centre distance = radius) has a double root here and
                // converges only to about the square root of the solver tolerance.
                GCS::Arc& a = arcs_.at(c.refs[1]);
                GCS::Point& p = points_.at(*shared);
                double angle = sys.calculateAngleViaPoint(l, a, p);
                while (angle > std::numbers::pi) angle -= 2.0 * std::numbers::pi;
                while (angle < -std::numbers::pi) angle += 2.0 * std::numbers::pi;
                sys.addConstraintAngleViaPoint(l, a, p, constant(std::abs(angle) > std::numbers::pi / 2.0 ? std::numbers::pi : 0.0), tag, true);
            } else if (auto a = arcs_.find(c.refs[1]); a != arcs_.end()) sys.addConstraintTangent(l, a->second, tag, true);
            else if (auto ci = circles_.find(c.refs[1]); ci != circles_.end()) sys.addConstraintTangent(l, ci->second, tag, true);
            else needRound(c, 1);
            return;
        }
        case ConstraintType::Distance:
            if (c.refs.size() == 1) {
                GCS::Line& l = L(c, 0);
                sys.addConstraintP2PDistance(l.p1, l.p2, constant(c.value), tag, true);
            } else {
                sys.addConstraintP2PDistance(Pt(c, 0), Pt(c, 1), constant(c.value), tag, true);
            }
            return;
        case ConstraintType::DistanceX: sys.addConstraintDifference(Pt(c, 0).x, Pt(c, 1).x, constant(c.value), tag, true); return;
        case ConstraintType::DistanceY: sys.addConstraintDifference(Pt(c, 0).y, Pt(c, 1).y, constant(c.value), tag, true); return;
        case ConstraintType::LineAngle: {
            GCS::Line& l = L(c, 0);
            // The 6-argument overload keeps the tag; the 5-argument one drops it and the conflict could not be named.
            sys.addConstraintP2PAngle(l.p1, l.p2, constant(c.value), 0.0, tag, true);
            return;
        }
        case ConstraintType::LineLineAngle: {
            GCS::Line& l1 = L(c, 0);
            GCS::Line& l2 = L(c, 1);
            const bool fixed1 = isReserved(c.refs[0]), fixed2 = isReserved(c.refs[1]);
            // Between rays: the angle of the line directions differs from the angle of the rays by half a turn when exactly
            // one of the two rays runs against its line.
            const double value = c.value + (c.rays && c.reverse1 != c.reverse2 ? std::numbers::pi : 0.0);
            // Against a fixed axis the angle is the absolute direction of the other line: the 6-argument
            // addConstraintP2PAngle (keeps the tag) with the axis direction as its offset.
            if (fixed1) sys.addConstraintP2PAngle(l2.p1, l2.p2, constant(value), axisAngle(c.refs[0]), tag, true);
            else if (fixed2) sys.addConstraintP2PAngle(l1.p1, l1.p2, constant(-value), axisAngle(c.refs[1]), tag, true);
            else sys.addConstraintL2LAngle(l1, l2, constant(value), tag, true);
            return;
        }
        case ConstraintType::DistancePointLine: sys.addConstraintP2LDistance(Pt(c, 0), L(c, 1), constant(c.value), tag, true); return;
        case ConstraintType::DistanceLineLine: sys.addConstraintP2LDistance(L(c, 0).p1, L(c, 1), constant(c.value), tag, true); return;
        case ConstraintType::DistancePointCircle: sys.addConstraintP2CDistance(Pt(c, 0), C(c, 1), constant(c.value), tag, true); return;
        case ConstraintType::DistanceCircleLine: sys.addConstraintC2LDistance(C(c, 0), L(c, 1), constant(c.value), tag, true); return;
        case ConstraintType::DistanceCircleCircle: sys.addConstraintC2CDistance(C(c, 0), C(c, 1), constant(c.value), tag, true); return;
        case ConstraintType::Radius:
            if (auto a = arcs_.find(c.refs[0]); a != arcs_.end()) sys.addConstraintArcRadius(a->second, constant(c.value), tag, true);
            else if (auto ci = circles_.find(c.refs[0]); ci != circles_.end()) sys.addConstraintCircleRadius(ci->second, constant(c.value), tag, true);
            else needRound(c, 0);
            return;
        case ConstraintType::Diameter:
            // The value is a constant: as an unknown, planegcs' equality reduction would drop the factor 0.5.
            if (auto a = arcs_.find(c.refs[0]); a != arcs_.end()) sys.addConstraintArcDiameter(a->second, constant(c.value), tag, true);
            else if (auto ci = circles_.find(c.refs[0]); ci != circles_.end()) sys.addConstraintCircleDiameter(ci->second, constant(c.value), tag, true);
            else needRound(c, 0);
            return;
        }
    }

    const Sketch& sketch_;
    ParameterBlock params_;
    std::vector<double*> unknowns_;
    std::vector<std::pair<double*, double*>> dragTargets_;
    std::map<std::string, GCS::Point> points_;
    std::map<std::string, GCS::Line> lines_;
    std::map<std::string, GCS::Circle> circles_;
    std::map<std::string, GCS::Arc> arcs_;

public:
    // Declared last so it is destroyed first, while the parameter block still exists.
    GCS::System sys;
};

// Ids of the elements a constraint refers to directly (fixed references left out).
void addRefs(const Sketch& s, const std::string& constraintId, std::set<std::string>& out) {
    for (const Constraint& c : s.constraints)
        if (c.id == constraintId)
            for (const std::string& r : c.refs)
                if (!isReserved(r)) out.insert(r);
}

} // namespace

const char* nameOf(SolveStatus s) {
    switch (s) {
    case SolveStatus::Solved: return "solved";
    case SolveStatus::Failed: return "failed";
    case SolveStatus::Conflicting: return "conflicting";
    case SolveStatus::Redundant: return "redundant";
    }
    return "failed";
}

const char* nameOf(EntityState s) {
    switch (s) {
    case EntityState::Under: return "under";
    case EntityState::Full: return "full";
    case EntityState::Over: return "over";
    }
    return "under";
}

namespace {

// A drag step (see the header): diagnose once, then pull the points to their targets in steps of at most
// maxDragStepMm. All steps run on one system; after each solved step initSolution starts the next one from the
// solution (planegcs resets to the state of its last initSolution at every solve) and keeps the diagnosis.
SolveResult solveDrag(const Sketch& sketch, const SolveOptions& options) {
    const auto t0 = Clock::now();
    validate(sketch);
    validateDrag(sketch, options.drag);
    SolveResult r;
    r.geometry = sketch;
    DragOutcome outcome;

    // Fixed points are no unknowns and never move; they get no constraint.
    std::vector<DragTarget> active;
    for (const DragTarget& d : options.drag)
        if (!sketch.point(d.point)->fixed) active.push_back(d);

    PlanegcsModel m(sketch, active);
    r.parameterCount = m.parameterCount();
    r.solverConstraintCount = m.solverConstraints;
    if (!m.hasUnknowns()) {
        r.status = SolveStatus::Solved;
        r.dof = 0;
        r.diagnosed = true;
    } else {
        m.sys.initSolution(GCS::DogLeg);  // the only diagnosis of this request; temporary constraints are not part of it
        m.diagnosis(r);
        if (!r.conflicting.empty()) {
            r.status = SolveStatus::Conflicting;
        } else if (!r.redundant.empty()) {
            r.status = SolveStatus::Redundant;
        } else {
            double longest = 0.0;
            for (const DragTarget& d : active) {
                const Point* p = sketch.point(d.point);
                longest = std::max(longest, std::hypot(d.x - p->x, d.y - p->y));
            }
            const double stepLength = options.maxDragStepMm > 0.0 ? options.maxDragStepMm : 1.0;
            const int steps = std::clamp(static_cast<int>(std::ceil(longest / stepLength)), 1, std::max(1, options.maxDragSteps));
            r.status = SolveStatus::Solved;
            for (int k = 1; k <= steps; ++k) {
                const double t = static_cast<double>(k) / steps;
                for (std::size_t i = 0; i < active.size(); ++i) {
                    const Point* p = sketch.point(active[i].point);
                    m.setDragTarget(i, p->x + (active[i].x - p->x) * t, p->y + (active[i].y - p->y) * t);
                }
                if (k > 1) m.sys.initSolution(GCS::DogLeg);
                if (m.sys.solve(true, GCS::DogLeg) != GCS::Success) {
                    // The first step is the only one that can leave the sketch exactly as sent without a solution; a
                    // later failure keeps the last good step.
                    outcome.complete = false;
                    break;
                }
                m.sys.applySolution();
                ++outcome.steps;
            }
            if (outcome.steps == 0) r.status = SolveStatus::Failed;
            else m.readBack(r.geometry);
        }
        if (options.diagnose && r.status != SolveStatus::Failed) m.freedom(r);
    }

    for (const DragTarget& d : options.drag) {
        const Point* before = sketch.point(d.point);
        const Point* after = r.geometry.point(d.point);
        DragPointOutcome o;
        o.point = d.point;
        o.error = std::hypot(d.x - after->x, d.y - after->y);
        o.moved = std::hypot(after->x - before->x, after->y - before->y) > 1e-9;
        outcome.points.push_back(std::move(o));
    }
    r.drag = std::move(outcome);
    for (const Constraint& c : sketch.constraints)
        if (!c.driving) r.reference[c.id] = measure(r.geometry, c);
    r.timeMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
    return r;
}

} // namespace

SolveResult solve(const Sketch& sketch, const SolveOptions& options) {
    if (!options.drag.empty()) return solveDrag(sketch, options);
    const auto t0 = Clock::now();
    validate(sketch);
    SolveResult r;
    r.geometry = sketch;
    bool unknowns = false;
    {
        PlanegcsModel m(sketch);
        r.parameterCount = m.parameterCount();
        r.solverConstraintCount = m.solverConstraints;
        unknowns = m.hasUnknowns();
        if (!unknowns) {
            r.status = SolveStatus::Solved;  // nothing can move
            r.dof = 0;
            r.diagnosed = true;
        } else {
            // As FreeCAD: diagnose with DogLeg in initSolution; refuse to solve conflicting or redundant sketches.
            m.sys.initSolution(GCS::DogLeg);
            m.diagnosis(r);
            if (!r.conflicting.empty()) {
                r.status = SolveStatus::Conflicting;
            } else if (!r.redundant.empty()) {
                r.status = SolveStatus::Redundant;
            } else if (m.sys.solve(true, GCS::DogLeg) == GCS::Success) {
                m.sys.applySolution();
                m.readBack(r.geometry);
                r.status = SolveStatus::Solved;
            } else {
                r.status = SolveStatus::Failed;
            }
            // Not solved: the states belong to the given geometry, diagnosed above.
            if (r.status != SolveStatus::Solved && options.diagnose) m.freedom(r);
        }
    }
    if (r.status == SolveStatus::Solved && unknowns && options.diagnose) {
        // planegcs diagnoses at the parameter values present in initSolution; the degrees of freedom and the free
        // parameters of the solved sketch are therefore diagnosed on a second system built from the solved geometry.
        PlanegcsModel m(r.geometry);
        m.sys.initSolution(GCS::DogLeg);
        m.diagnosis(r);
        m.freedom(r);
    }
    for (const Constraint& c : sketch.constraints)
        if (!c.driving) r.reference[c.id] = measure(r.geometry, c);
    r.timeMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
    return r;
}

std::map<std::string, EntityState> entityStates(const Sketch& sketch, const SolveResult& r) {
    std::set<std::string> over;
    for (const std::string& id : r.conflicting) addRefs(sketch, id, over);
    std::map<std::string, EntityState> states;
    const auto state = [&](const std::string& id, bool free) {
        return over.count(id) ? EntityState::Over : free ? EntityState::Under : EntityState::Full;
    };
    for (const Point& p : sketch.points) states[p.id] = state(p.id, r.freePoints.count(p.id) > 0);
    for (const Line& l : sketch.lines) states[l.id] = state(l.id, r.freePoints.count(l.p1) || r.freePoints.count(l.p2));
    for (const Circle& c : sketch.circles) states[c.id] = state(c.id, r.freePoints.count(c.center) || r.freeRadii.count(c.id));
    return states;
}

std::string eigenVersion() {
    return std::to_string(EIGEN_WORLD_VERSION) + "." + std::to_string(EIGEN_MAJOR_VERSION) + "." + std::to_string(EIGEN_MINOR_VERSION);
}

std::string boostVersion() {
    return std::to_string(BOOST_VERSION / 100000) + "." + std::to_string(BOOST_VERSION / 100 % 1000) + "." +
           std::to_string(BOOST_VERSION % 100);
}

} // namespace pc::sketch
