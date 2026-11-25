#include "sketch/sketch_solver.hpp"

#include "sketch/sketch_check.hpp"

#include <GCS.h>

#include <Eigen/Core>
#include <boost/version.hpp>

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

std::size_t countParameters(const Sketch& s) {
    std::size_t n = 2 * s.points.size() + s.circles.size() + 3 * s.arcs.size();
    for (const Constraint& c : s.constraints) {
        if (!c.driving) continue;
        if (hasValue(c.type)) ++n;
        if (sharedTangentPoint(s, c)) ++n;  // the locked angle (0 or pi) of the tangency at the shared point
    }
    return n;
}

std::size_t expectedRefs(ConstraintType t) {
    switch (t) {
    case ConstraintType::Horizontal:
    case ConstraintType::Vertical:
    case ConstraintType::LineAngle:
    case ConstraintType::Radius:
    case ConstraintType::Diameter: return 1;
    default: return 2;
    }
}

void validate(const Sketch& s) {
    std::set<std::string> ids;
    const auto claim = [&ids](const std::string& id, const char* kind) {
        if (id.empty()) throw SketchError(std::string("A ") + kind + " of the sketch has an empty id.");
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
        if (!constraintIds.insert(c.id).second) throw SketchError("The constraint id \"" + c.id + "\" is used twice in the sketch.");
        if (c.refs.size() != expectedRefs(c.type))
            throw SketchError("Constraint \"" + c.id + "\" (" + nameOf(c.type) + ") needs " + std::to_string(expectedRefs(c.type)) +
                              " references, got " + std::to_string(c.refs.size()) + ".");
        if (hasValue(c.type)) finite(c.value, "The value of constraint \"" + c.id + "\"");
        if (!c.driving && !hasValue(c.type))
            throw SketchError("Constraint \"" + c.id + "\" (" + nameOf(c.type) + ") cannot be a reference dimension; only distance, "
                              "lineAngle, radius and diameter can.");
    }
}

// One planegcs system built from a sketch. Lives only for one solve or diagnosis.
class PlanegcsModel {
public:
    explicit PlanegcsModel(const Sketch& s) : sketch_(s), params_(countParameters(s)) {
        sys.debugMode = GCS::NoDebug;
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
        if (params_.size() != params_.limit())
            throw std::logic_error("sketch solver: " + std::to_string(params_.size()) + " parameters created, " +
                                   std::to_string(params_.limit()) + " counted");
        sys.declareUnknowns(unknowns_);
    }

    ~PlanegcsModel() { sys.clear(); }
    PlanegcsModel(const PlanegcsModel&) = delete;
    PlanegcsModel& operator=(const PlanegcsModel&) = delete;

    bool hasUnknowns() const { return !unknowns_.empty(); }
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

    std::size_t solverConstraints = 0;

private:
    double* unknown(double v) {
        double* p = params_.add(v);
        unknowns_.push_back(p);
        return p;
    }
    double* constant(double v) { return params_.add(v); }

    GCS::Point& P(const std::string& id) { return points_.at(id); }
    GCS::Line& L(const Constraint& c, std::size_t i) {
        const auto it = lines_.find(c.refs[i]);
        if (it == lines_.end())
            throw SketchError("Constraint \"" + c.id + "\" (" + nameOf(c.type) + ") needs a line as reference " + std::to_string(i + 1) +
                              ", got \"" + c.refs[i] + "\".");
        return it->second;
    }
    GCS::Point& Pt(const Constraint& c, std::size_t i) {
        const auto it = points_.find(c.refs[i]);
        if (it == points_.end())
            throw SketchError("Constraint \"" + c.id + "\" (" + nameOf(c.type) + ") needs a point as reference " + std::to_string(i + 1) +
                              ", got \"" + c.refs[i] + "\".");
        return it->second;
    }
    [[noreturn]] void needRound(const Constraint& c, std::size_t i) const {
        throw SketchError("Constraint \"" + c.id + "\" (" + nameOf(c.type) + ") needs a circle or arc as reference " +
                          std::to_string(i + 1) + ", got \"" + c.refs[i] + "\".");
    }

    void addConstraint(const Constraint& c, int tag) {
        switch (c.type) {
        case ConstraintType::Coincident: sys.addConstraintP2PCoincident(Pt(c, 0), Pt(c, 1), tag, true); return;
        case ConstraintType::Horizontal: sys.addConstraintHorizontal(L(c, 0), tag, true); return;
        case ConstraintType::Vertical: sys.addConstraintVertical(L(c, 0), tag, true); return;
        case ConstraintType::Parallel: sys.addConstraintParallel(L(c, 0), L(c, 1), tag, true); return;
        case ConstraintType::Perpendicular: sys.addConstraintPerpendicular(L(c, 0), L(c, 1), tag, true); return;
        case ConstraintType::PointOnLine: sys.addConstraintPointOnLine(Pt(c, 0), L(c, 1), tag, true); return;
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
        case ConstraintType::Distance: sys.addConstraintP2PDistance(Pt(c, 0), Pt(c, 1), constant(c.value), tag, true); return;
        case ConstraintType::LineAngle: {
            GCS::Line& l = L(c, 0);
            // The 6-argument overload keeps the tag; the 5-argument one drops it and the conflict could not be named.
            sys.addConstraintP2PAngle(l.p1, l.p2, constant(c.value), 0.0, tag, true);
            return;
        }
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
    std::map<std::string, GCS::Point> points_;
    std::map<std::string, GCS::Line> lines_;
    std::map<std::string, GCS::Circle> circles_;
    std::map<std::string, GCS::Arc> arcs_;

public:
    // Declared last so it is destroyed first, while the parameter block still exists.
    GCS::System sys;
};

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

SolveResult solve(const Sketch& sketch) {
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
        }
    }
    if (r.status == SolveStatus::Solved && unknowns) {
        // planegcs diagnoses at the parameter values present in initSolution; the degrees of freedom of the
        // solved sketch are therefore diagnosed on a second system built from the solved geometry.
        PlanegcsModel m(r.geometry);
        m.sys.initSolution(GCS::DogLeg);
        m.diagnosis(r);
    }
    for (const Constraint& c : sketch.constraints)
        if (!c.driving) r.reference[c.id] = measure(r.geometry, c);
    r.timeMs = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
    return r;
}

std::string eigenVersion() {
    return std::to_string(EIGEN_WORLD_VERSION) + "." + std::to_string(EIGEN_MAJOR_VERSION) + "." + std::to_string(EIGEN_MINOR_VERSION);
}

std::string boostVersion() {
    return std::to_string(BOOST_VERSION / 100000) + "." + std::to_string(BOOST_VERSION / 100 % 1000) + "." +
           std::to_string(BOOST_VERSION % 100);
}

} // namespace pc::sketch
