// Solver test driver for planegcs (FreeCAD's 2D constraint solver), tracks "native-msvc" and
// "own-emscripten".
//
//   solvertest_driver <cases.json> <result.json> [--track name] [--runtime text] [--run-date d]
//                     [--only id1,id2] [--reps n] [--slow-ms ms] [--verbose] [--planegcs-only]
//
// Reads the solver-neutral catalogue (cases.json plus the large-*.json files it references), maps
// every neutral constraint onto the GCS::System API, solves, diagnoses, reads the geometry and the
// non-driving values back, runs step sequences and writes the common result format. Portable C++20:
// no platform API, std::chrono for timing, every path comes from argv.
//
// Diagnosis protocol (spikes/solvertest/CASES.md section 1): pass 1 builds the system from the
// start geometry and solves; pass 2 rebuilds it from the solved geometry and runs the diagnosis
// (planegcs diagnoses at the parameter values present when initSolution() runs).

#include <GCS.h>
#include <Base/Console.h>

#include <Eigen/Core>
#include <boost/version.hpp>
#include <nlohmann/json.hpp>

#include "build_info.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <numbers>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#if defined(__EMSCRIPTEN__)
#include <emscripten/version.h>  // __EMSCRIPTEN_MAJOR__ etc., only used for the build info
#endif

using json = nlohmann::ordered_json;
using Clock = std::chrono::steady_clock;

namespace
{

constexpr double kPiConst = std::numbers::pi;
bool gVerbose = false;  // --verbose: print planegcs' iteration log of the counting run to stderr
bool gOwnConstraints = true;  // --planegcs-only switches the own curvature constraint off

// ------------------------------------------------------------------------------------------------
// small helpers
// ------------------------------------------------------------------------------------------------

double msSince(Clock::time_point a, Clock::time_point b)
{
    return std::chrono::duration<double, std::milli>(b - a).count();
}

double median(std::vector<double> v)
{
    if (v.empty()) {
        return std::nan("");
    }
    std::sort(v.begin(), v.end());
    size_t n = v.size();
    return n % 2 ? v[n / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

const char* statusName(int s)
{
    switch (s) {
        case GCS::Success:
            return "Success";
        case GCS::Converged:
            return "Converged";
        case GCS::Failed:
            return "Failed";
        case GCS::SuccessfulSolutionInvalid:
            return "SuccessfulSolutionInvalid";
        default:
            return "Unknown";
    }
}

GCS::Algorithm algorithmFromName(const std::string& n)
{
    if (n == "DogLeg") {
        return GCS::DogLeg;
    }
    if (n == "LevenbergMarquardt") {
        return GCS::LevenbergMarquardt;
    }
    if (n == "BFGS") {
        return GCS::BFGS;
    }
    throw std::runtime_error("unknown algorithm " + n);
}

std::string jstr(const json& j, const char* key)
{
    return j.at(key).get<std::string>();
}

// Thrown while building a system when a neutral constraint has no planegcs mapping.
struct Unsupported: std::runtime_error
{
    using std::runtime_error::runtime_error;
};

// ------------------------------------------------------------------------------------------------
// solver-independent state: geometry values and the effective constraint set of a step
// ------------------------------------------------------------------------------------------------

struct Geometry
{
    std::map<std::string, std::array<double, 2>> points;
    std::map<std::string, double> radius;
    // auxiliary solver values that must survive a rebuild (curve parameter of a point on a
    // B-spline, knot point position, the locked 0/pi choice of a tangency via point)
    std::map<std::string, double> aux;
};

Geometry initialGeometry(const json& c)
{
    Geometry g;
    for (const auto& e : c.at("elements")) {
        const std::string t = jstr(e, "type");
        if (t == "point") {
            g.points[jstr(e, "id")] = {e.at("x").get<double>(), e.at("y").get<double>()};
        }
        else if (t == "circle" || t == "arc") {
            g.radius[jstr(e, "id")] = e.at("radius").get<double>();
        }
    }
    return g;
}

struct CState
{
    const json* def = nullptr;
    int index = 0;  // position in the case's constraint list (tag = index + 1)
    bool enabled = true;
    bool driving = true;
    double value = 0;
    double x = 0;
    double y = 0;
};

std::vector<CState> effectiveState(const json& c, size_t stepIndex)
{
    std::vector<CState> st;
    int i = 0;
    for (const auto& k : c.at("constraints")) {
        CState s;
        s.def = &k;
        s.index = i++;
        s.enabled = !(k.contains("enabled") && k.at("enabled") == false);
        s.driving = !(k.contains("driving") && k.at("driving") == false);
        if (k.contains("value")) {
            s.value = k.at("value").get<double>();
        }
        if (k.contains("x")) {
            s.x = k.at("x").get<double>();
        }
        if (k.contains("y")) {
            s.y = k.at("y").get<double>();
        }
        st.push_back(s);
    }
    auto find = [&](const std::string& id) -> CState& {
        for (auto& s : st) {
            if (jstr(*s.def, "id") == id) {
                return s;
            }
        }
        throw std::runtime_error("step refers to unknown constraint " + id);
    };
    if (c.contains("steps")) {
        const auto& steps = c.at("steps");
        for (size_t k = 1; k <= stepIndex && k <= steps.size(); ++k) {
            const auto& s = steps[k - 1];
            if (s.contains("disable")) {
                for (const auto& id : s.at("disable")) {
                    find(id.get<std::string>()).enabled = false;
                }
            }
            if (s.contains("enable")) {
                for (const auto& id : s.at("enable")) {
                    find(id.get<std::string>()).enabled = true;
                }
            }
            if (s.contains("set")) {
                for (const auto& [id, v] : s.at("set").items()) {
                    CState& cs = find(id);
                    if (v.is_number()) {
                        cs.value = v.get<double>();
                    }
                    else {
                        if (v.contains("value")) {
                            cs.value = v.at("value").get<double>();
                        }
                        if (v.contains("x")) {
                            cs.x = v.at("x").get<double>();
                        }
                        if (v.contains("y")) {
                            cs.y = v.at("y").get<double>();
                        }
                    }
                }
            }
        }
    }
    return st;
}

struct Drag
{
    std::string point;
    double x = 0;
    double y = 0;
};

// ------------------------------------------------------------------------------------------------
// the planegcs model of one solver run
// ------------------------------------------------------------------------------------------------

enum class MapClass
{
    Direct,
    Composed
};

// ------------------------------------------------------------------------------------------------
// Own constraint (NOT part of planegcs): equal signed curvature of a circle/arc and the clamped
// end of a non-rational B-spline at their junction. planegcs has no curvature constraint; this
// subclass of GCS::Constraint (public System::addConstraint, GCS.h:266) is the "new constraint
// class" proposed in CASES.md. It is used together with a coincident and a tangent (angle via
// point) constraint, so the curvature vectors are both normal to the common tangent and one
// scalar equation is enough:
//   residual = (kappa_circle - kappa_spline) . n,  n = unit normal of the spline's end tangent
// with kappa_circle = (centre - q0) / r^2 and kappa_spline = (C'' . n) / |C'|^2 at the end.
// End derivatives of a clamped B-spline (NURBS book eq. 3.9/3.10 applied twice):
//   C'  = p / D1 * (q1 - q0)
//   C'' = p (p - 1) / D2 * ((q2 - q1) / D3 - (q1 - q0) / D1)
// where q0, q1, q2 are the first three poles counted from that end and D1, D2, D3 the knot
// spans U[p+1]-U[1], U[p+1]-U[2], U[p+2]-U[2] of the flattened knot vector seen from that end.
// The gradient is a central difference (adequate for a spike, not for the product).
// ------------------------------------------------------------------------------------------------
class ConstraintEqualCurvatureCircleSplineEnd: public GCS::Constraint
{
public:
    ConstraintEqualCurvatureCircleSplineEnd(GCS::Circle& c, GCS::BSpline& b, bool atStart)
        : degree(b.degree)
    {
        const size_t n = b.poles.size();
        const auto& U = b.flattenedknots;
        const size_t m = U.size() - 1;
        const int p = b.degree;
        if (atStart) {
            D1 = U[p + 1] - U[1];
            D2 = U[p + 1] - U[2];
            D3 = U[p + 2] - U[2];
        }
        else {
            D1 = U[m - 1] - U[m - p - 1];
            D2 = U[m - 2] - U[m - p - 1];
            D3 = U[m - 2] - U[m - p - 2];
        }
        pvec.push_back(c.center.x);
        pvec.push_back(c.center.y);
        pvec.push_back(c.rad);
        for (size_t i = 0; i < 3; ++i) {
            const GCS::Point& q = atStart ? b.poles[i] : b.poles[n - 1 - i];
            pvec.push_back(q.x);
            pvec.push_back(q.y);
        }
        origpvec = pvec;
        rescale();
    }

    double error() override
    {
        const double cx = *pvec[0], cy = *pvec[1], r = *pvec[2];
        const double q0x = *pvec[3], q0y = *pvec[4], q1x = *pvec[5], q1y = *pvec[6], q2x = *pvec[7], q2y = *pvec[8];
        const double p = degree;
        const double d1x = p / D1 * (q1x - q0x), d1y = p / D1 * (q1y - q0y);
        const double d2x = p * (p - 1) / D2 * ((q2x - q1x) / D3 - (q1x - q0x) / D1);
        const double d2y = p * (p - 1) / D2 * ((q2y - q1y) / D3 - (q1y - q0y) / D1);
        const double sp = std::hypot(d1x, d1y);
        if (sp == 0 || r == 0) {
            return 0;
        }
        const double nx = -d1y / sp, ny = d1x / sp;
        const double kSpline = (d2x * nx + d2y * ny) / (sp * sp);
        const double kCircle = ((cx - q0x) * nx + (cy - q0y) * ny) / (r * r);
        return scale * (kCircle - kSpline);
    }

    double grad(double* param) override
    {
        if (findParamInPvec(param) < 0) {
            return 0;
        }
        const double old = *param;
        const double h = 1e-7 * std::max(1.0, std::fabs(old));
        *param = old + h;
        const double ep = error();
        *param = old - h;
        const double em = error();
        *param = old;
        return (ep - em) / (2 * h);
    }

private:
    int degree;
    double D1 = 1, D2 = 1, D3 = 1;
};

class Model
{
public:
    Model(const json& c, const Geometry& g, const std::vector<CState>& state, const Drag* drag)
        : caseDef(c)
        , geo(g)
    {
        sys.debugMode = GCS::NoDebug;
        // generous upper bound: no element or constraint creates more than 16 parameters
        // (B-spline weights and knots are added per pole / knot)
        size_t estimate = 64;
        for (const auto& e : c.at("elements")) {
            estimate += 16 + (e.contains("poles") ? 2 * e.at("poles").size() + e.at("knots").size() : 0);
        }
        estimate += 16 * c.at("constraints").size();
        store.reserve(estimate);
        buildGeometry();
        for (const auto& s : state) {
            if (s.enabled) {
                addCaseConstraint(s);
            }
        }
        if (drag) {
            // Temporary drag constraint as in FreeCAD's Sketch::initMove (Sketch.cpp:4945 ff.):
            // the point is tied to fixed "mouse" parameters with tag -1 (GCS.h:100-103). The
            // tagged-negative constraint goes to the auxiliary subsystem and is solved by SQP.
            GCS::Point mouse {param(drag->x, false), param(drag->y, false)};
            sys.addConstraintP2PCoincident(mouse, P(drag->point), GCS::DefaultTemporaryConstraint);
            hasAuxConstraints = true;
        }
        sys.declareUnknowns(unknowns);
        sys.declareDrivenParams(driven);
    }

    // delete the solver's constraints and subsystems while the parameter storage still exists
    ~Model()
    {
        sys.clear();
    }

    Model(const Model&) = delete;
    Model& operator=(const Model&) = delete;

    // geometry after applySolution()
    Geometry readBack() const
    {
        Geometry out;
        for (const auto& [id, p] : points) {
            out.points[id] = {*p.x, *p.y};
        }
        for (const auto& [id, c] : circles) {
            out.radius[id] = *c.rad;
        }
        for (const auto& [id, a] : arcs) {
            out.radius[id] = *a.rad;
        }
        for (const auto& [k, p] : auxParams) {
            out.aux[k] = *p;
        }
        for (const auto& [k, v] : auxValues) {
            out.aux[k] = v;
        }
        return out;
    }

    json drivenValues() const
    {
        json d = json::object();
        for (const auto& [id, nd] : nonDriving) {
            double v = *nd.value;
            if (nd.diameterOfFreeRadius) {
                // FreeCAD's own correction (Sketch.cpp:4726-4751): a diameter is a proportional
                // constraint of type Equal (GCS.cpp:617-623, 1169-1177); when both parameters are
                // unknown, initSolution() eliminates it as a plain equality and the value
                // parameter receives the radius (GCS.cpp:1781-1797). FreeCAD doubles it then.
                v *= 2.0;
            }
            d[id] = v;
        }
        return d;
    }

    std::string idOfTag(int tag) const
    {
        const auto& cs = caseDef.at("constraints");
        if (tag >= 1 && tag <= int(cs.size())) {
            return jstr(cs[tag - 1], "id");
        }
        return "tag" + std::to_string(tag);
    }

    json tagsToIds(const GCS::VEC_I& tags) const
    {
        std::set<std::string> ids;
        for (int t : tags) {
            ids.insert(idOfTag(t));
        }
        json a = json::array();
        for (const auto& s : ids) {
            a.push_back(s);
        }
        return a;
    }

    json diagnosis() const
    {
        GCS::VEC_I conf, red, pred;
        sys.getConflicting(conf);
        sys.getRedundant(red);
        sys.getPartiallyRedundant(pred);
        json d;
        d["dof"] = sys.dofsNumber();
        d["conflicting"] = tagsToIds(conf);
        d["redundant"] = tagsToIds(red);
        d["partially_redundant"] = tagsToIds(pred);
        return d;
    }

    GCS::System sys;
    bool hasAuxConstraints = false;  // non-driving or temporary constraints -> SQP path
    bool anyComposed = false;
    std::vector<std::string> mappingText;

private:
    struct NonDriving
    {
        double* value = nullptr;
        bool diameterOfFreeRadius = false;
    };

    const json& caseDef;
    const Geometry& geo;
    // Every solver parameter lives in ONE contiguous, pre-reserved array. planegcs orders the unknowns
    // of a subsystem by pointer value (std::set<double*> in SubSystem::initialize, SubSystem.cpp:56-68;
    // SET_pD in Util.h:39), so the Jacobian column order - and with it the particular solution of an
    // under-determined system - depends on the parameter addresses. With one array the order is the
    // creation order on every run; separately allocated parameters (as with a std::deque, or FreeCAD's
    // "new double" per parameter) make the result depend on the heap layout.
    std::vector<double> store;
    std::vector<double*> unknowns;
    std::vector<double*> driven;
    std::set<double*> unknownSet;
    std::map<std::string, GCS::Point> points;
    std::map<std::string, GCS::Line> lines;
    std::map<std::string, GCS::Circle> circles;
    std::map<std::string, GCS::Arc> arcs;
    std::map<std::string, GCS::BSpline> splines;
    std::map<std::string, std::string> elementType;
    std::map<std::string, double*> auxParams;  // solver unknowns that are kept across rebuilds
    std::map<std::string, double> auxValues;   // locked choices (constants)
    std::map<std::string, NonDriving> nonDriving;

    double* param(double v, bool unknown)
    {
        if (store.size() == store.capacity()) {
            // a reallocation would invalidate every pointer handed to planegcs
            throw std::runtime_error("parameter storage too small (reserve estimate)");
        }
        store.push_back(v);
        double* p = &store.back();
        if (unknown) {
            unknowns.push_back(p);
            unknownSet.insert(p);
        }
        return p;
    }

    const json& element(const std::string& id) const
    {
        for (const auto& e : caseDef.at("elements")) {
            if (jstr(e, "id") == id) {
                return e;
            }
        }
        throw std::runtime_error("unknown element " + id);
    }

    void buildGeometry()
    {
        for (const auto& e : caseDef.at("elements")) {
            elementType[jstr(e, "id")] = jstr(e, "type");
        }
        // points first: lines, circles, arcs and splines refer to them
        for (const auto& e : caseDef.at("elements")) {
            if (jstr(e, "type") != "point") {
                continue;
            }
            const std::string id = jstr(e, "id");
            const bool fixed = e.contains("fixed") && e.at("fixed") == true;
            const auto& xy = geo.points.at(id);
            // A fixed point is not declared unknown (FreeCAD's FixParameters, Sketch.cpp:878)
            points[id] = GCS::Point(param(xy[0], !fixed), param(xy[1], !fixed));
        }
        for (const auto& e : caseDef.at("elements")) {
            const std::string t = jstr(e, "type");
            const std::string id = jstr(e, "id");
            if (t == "line") {
                GCS::Line l;
                l.p1 = points.at(jstr(e, "p1"));
                l.p2 = points.at(jstr(e, "p2"));
                lines[id] = l;
            }
            else if (t == "circle") {
                GCS::Circle c;
                c.center = points.at(jstr(e, "center"));
                c.rad = param(geo.radius.at(id), true);
                circles[id] = c;
            }
            else if (t == "arc") {
                // as FreeCAD's Sketch::addArc (Sketch.cpp:876-942): start, end, centre, radius,
                // start and end angle are parameters, tied by the arc rules (tag 0)
                GCS::Arc a;
                a.center = points.at(jstr(e, "center"));
                a.start = points.at(jstr(e, "start"));
                a.end = points.at(jstr(e, "end"));
                const double cx = *a.center.x, cy = *a.center.y;
                double sa = std::atan2(*a.start.y - cy, *a.start.x - cx);
                double ea = std::atan2(*a.end.y - cy, *a.end.x - cx);
                if (ea <= sa) {
                    ea += 2 * kPiConst;  // counter-clockwise from start to end, end > start
                }
                a.rad = param(geo.radius.at(id), true);
                a.startAngle = param(sa, true);
                a.endAngle = param(ea, true);
                arcs[id] = a;
            }
            else if (t == "bspline") {
                GCS::BSpline b;
                for (const auto& pid : e.at("poles")) {
                    b.poles.push_back(points.at(pid.get<std::string>()));
                }
                // weights and knots are constants here (the catalogue does not vary them);
                // FreeCAD makes weights unknowns and ties them to pole circles instead.
                for (const auto& w : e.at("weights")) {
                    b.weights.push_back(param(w.get<double>(), false));
                }
                for (const auto& k : e.at("knots")) {
                    b.knots.push_back(param(k.get<double>(), false));
                }
                for (const auto& m : e.at("mult")) {
                    b.mult.push_back(m.get<int>());
                }
                b.degree = e.at("degree").get<int>();
                b.periodic = e.at("periodic").get<bool>();
                b.setupFlattenedKnots();
                const bool clampedStart = !b.periodic && b.mult.front() > b.degree;
                const bool clampedEnd = !b.periodic && b.mult.back() > b.degree;
                // For a clamped end the curve end IS the end pole. FreeCAD creates separate
                // start/end points and ties them with coincident constraints (Sketch.cpp:1583-1590);
                // here start/end simply share the pole's parameters, which adds no unknowns and
                // makes the exact-coordinate test in BSpline::CalculateNormal (Geo.cpp:723, 732)
                // true by construction.
                if (clampedStart) {
                    b.start = b.poles.front();
                }
                else {
                    GCS::DeriVector2 v = b.Value(*b.knots.front(), 0);
                    b.start = GCS::Point(param(v.x, false), param(v.y, false));
                }
                if (clampedEnd) {
                    b.end = b.poles.back();
                }
                else {
                    GCS::DeriVector2 v = b.Value(*b.knots.back(), 0);
                    b.end = GCS::Point(param(v.x, false), param(v.y, false));
                }
                b.knotpointGeoids.assign(b.knots.size(), -2000);
                splines[id] = b;
            }
        }
        // arc rules after all arcs exist (map addresses are stable)
        for (auto& [id, a] : arcs) {
            sys.addConstraintArcRules(a, 0, true);
        }
    }

    GCS::Point& P(const std::string& id)
    {
        auto it = points.find(id);
        if (it == points.end()) {
            throw std::runtime_error("point expected: " + id);
        }
        return it->second;
    }
    GCS::Line& L(const std::string& id)
    {
        auto it = lines.find(id);
        if (it == lines.end()) {
            throw std::runtime_error("line expected: " + id);
        }
        return it->second;
    }
    GCS::Curve& curve(const std::string& id)
    {
        const std::string& t = elementType.at(id);
        if (t == "line") {
            return lines.at(id);
        }
        if (t == "circle") {
            return circles.at(id);
        }
        if (t == "arc") {
            return arcs.at(id);
        }
        if (t == "bspline") {
            return splines.at(id);
        }
        throw std::runtime_error("curve expected: " + id);
    }
    GCS::Point& centerOf(const std::string& id)
    {
        const std::string& t = elementType.at(id);
        if (t == "circle") {
            return circles.at(id).center;
        }
        if (t == "arc") {
            return arcs.at(id).center;
        }
        throw std::runtime_error("circle or arc expected: " + id);
    }
    double* radiusOf(const std::string& id)
    {
        const std::string& t = elementType.at(id);
        if (t == "circle") {
            return circles.at(id).rad;
        }
        if (t == "arc") {
            return arcs.at(id).rad;
        }
        throw std::runtime_error("circle or arc expected: " + id);
    }

    double auxOr(const std::string& key, double fallback) const
    {
        auto it = geo.aux.find(key);
        return it == geo.aux.end() ? fallback : it->second;
    }

    double* auxUnknown(const std::string& key, double initial)
    {
        double* p = param(auxOr(key, initial), true);
        auxParams[key] = p;
        return p;
    }

    // Tangency (or G2) at a shared end point: FreeCAD's endpoint-to-endpoint branch of
    // Sketch::addAngleAtPointConstraint (Sketch.cpp:3324-3331): coincident + angle via point. The
    // angle is 0 or pi, chosen from the current geometry (Sketch.cpp:3270-3286) and then locked
    // (FreeCAD stores the choice in the constraint value; here it is kept in Geometry::aux).
    void addJoinTangency(const std::string& cid, int tag, bool drv, const std::string& a,
                         const std::string& b, const std::string& p1, const std::string& p2)
    {
        GCS::Curve& ca = curve(a);
        GCS::Curve& cb = curve(b);
        sys.addConstraintP2PCoincident(P(p1), P(p2), tag, drv);
        // The point used for the normals: a B-spline's normal is only defined when the point IS
        // its start/end point by exact coordinates (Geo.cpp:713-746), so use the spline's own pole.
        GCS::Point& p = elementType.at(b) == "bspline" ? P(p2) : P(p1);
        const std::string key = cid + ".angle";
        double angle;
        auto it = geo.aux.find(key);
        if (it != geo.aux.end()) {
            angle = it->second;
        }
        else {
            double err = sys.calculateAngleViaPoint(ca, cb, p);
            if (err > kPiConst) {
                err -= 2 * kPiConst;
            }
            if (err < -kPiConst) {
                err += 2 * kPiConst;
            }
            angle = std::fabs(err) > kPiConst / 2 ? kPiConst : 0.0;
        }
        auxValues[key] = angle;
        sys.addConstraintAngleViaPoint(ca, cb, p, param(angle, false), tag, drv);
    }

    double* valueParam(const CState& s, const std::string& cid, bool diameterOfFreeRadius = false)
    {
        // Driving: a constant (FreeCAD FixParameters). Non-driving: an unknown that is also
        // declared "driven" so that it does not count as a degree of freedom (Sketch.cpp:1938-1945).
        double* v = param(s.value, !s.driving);
        if (!s.driving) {
            driven.push_back(v);
            nonDriving[cid] = NonDriving {v, diameterOfFreeRadius};
            hasAuxConstraints = true;
        }
        return v;
    }

    void note(const std::string& cid, const std::string& type, MapClass cls, const std::string& txt)
    {
        mappingText.push_back(cid + " " + type + " -> " + txt + (cls == MapClass::Composed ? " [composed]" : ""));
        if (cls == MapClass::Composed) {
            anyComposed = true;
        }
    }

    void addCaseConstraint(const CState& s)
    {
        const json& k = *s.def;
        const std::string cid = jstr(k, "id");
        const std::string type = jstr(k, "type");
        const int tag = s.index + 1;
        const bool drv = s.driving;
        auto has = [&](const char* f) { return k.contains(f); };
        auto f = [&](const char* name) { return jstr(k, name); };

        if (type == "horizontal" || type == "vertical") {
            const bool h = type == "horizontal";
            if (has("line")) {
                h ? sys.addConstraintHorizontal(L(f("line")), tag, drv) : sys.addConstraintVertical(L(f("line")), tag, drv);
                note(cid, type, MapClass::Direct, h ? "addConstraintHorizontal(Line)" : "addConstraintVertical(Line)");
            }
            else {
                h ? sys.addConstraintHorizontal(P(f("p1")), P(f("p2")), tag, drv)
                  : sys.addConstraintVertical(P(f("p1")), P(f("p2")), tag, drv);
                note(cid, type, MapClass::Direct, h ? "addConstraintHorizontal(Point,Point)" : "addConstraintVertical(Point,Point)");
            }
        }
        else if (type == "coincident") {
            sys.addConstraintP2PCoincident(P(f("p1")), P(f("p2")), tag, drv);
            note(cid, type, MapClass::Direct, "addConstraintP2PCoincident");
        }
        else if (type == "point_on_curve") {
            const std::string crv = f("curve");
            const std::string& t = elementType.at(crv);
            GCS::Point& p = P(f("point"));
            if (t == "line") {
                sys.addConstraintPointOnLine(p, lines.at(crv), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintPointOnLine");
            }
            else if (t == "circle") {
                sys.addConstraintPointOnCircle(p, circles.at(crv), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintPointOnCircle");
            }
            else if (t == "arc") {
                sys.addConstraintPointOnArc(p, arcs.at(crv), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintPointOnArc (circle of the arc)");
            }
            else if (t == "bspline") {
                double* u = auxUnknown(cid + ".u", k.at("u0").get<double>());
                sys.addConstraintPointOnBSpline(p, splines.at(crv), u, tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintPointOnBSpline with the curve parameter as extra unknown");
            }
            else {
                throw Unsupported("point_on_curve on " + t);
            }
        }
        else if (type == "tangent") {
            std::string a = f("a"), b = f("b");
            std::string ta = elementType.at(a), tb = elementType.at(b);
            if (tb == "line") {
                std::swap(a, b);
                std::swap(ta, tb);
            }
            if (ta == "circle" && tb == "arc") {
                // addConstraintTangent(Circle&, Arc&)
            }
            else if (ta == "arc" && tb == "circle") {
                std::swap(a, b);
                std::swap(ta, tb);
            }
            if (ta == "line" && tb == "circle") {
                sys.addConstraintTangent(lines.at(a), circles.at(b), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintTangent(Line,Circle)");
            }
            else if (ta == "line" && tb == "arc") {
                sys.addConstraintTangent(lines.at(a), arcs.at(b), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintTangent(Line,Arc)");
            }
            else if (ta == "circle" && tb == "circle") {
                sys.addConstraintTangent(circles.at(a), circles.at(b), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintTangent(Circle,Circle) (internal/external from the current geometry)");
            }
            else if (ta == "circle" && tb == "arc") {
                sys.addConstraintTangent(circles.at(a), arcs.at(b), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintTangent(Circle,Arc)");
            }
            else if (ta == "arc" && tb == "arc") {
                sys.addConstraintTangent(arcs.at(a), arcs.at(b), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintTangent(Arc,Arc)");
            }
            else {
                throw Unsupported("tangent between " + ta + " and " + tb + " (FreeCAD refuses it, Sketch.cpp:2908-3058)");
            }
        }
        else if (type == "tangent_at") {
            addJoinTangency(cid, tag, drv, f("a"), f("b"), f("p1"), f("p2"));
            note(cid, type, MapClass::Composed, "addConstraintP2PCoincident + addConstraintAngleViaPoint(angle 0 or pi, locked)");
        }
        else if (type == "equal") {
            std::string a = f("a"), b = f("b");
            std::string ta = elementType.at(a), tb = elementType.at(b);
            if (ta == "line" && tb == "line") {
                sys.addConstraintEqualLength(lines.at(a), lines.at(b), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintEqualLength");
            }
            else if (ta == "circle" && tb == "circle") {
                sys.addConstraintEqualRadius(circles.at(a), circles.at(b), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintEqualRadius(Circle,Circle)");
            }
            else if ((ta == "circle" && tb == "arc") || (ta == "arc" && tb == "circle")) {
                if (ta == "arc") {
                    std::swap(a, b);
                }
                sys.addConstraintEqualRadius(circles.at(a), arcs.at(b), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintEqualRadius(Circle,Arc)");
            }
            else if (ta == "arc" && tb == "arc") {
                sys.addConstraintEqualRadius(arcs.at(a), arcs.at(b), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintEqualRadius(Arc,Arc)");
            }
            else {
                throw Unsupported("equal between " + ta + " and " + tb);
            }
        }
        else if (type == "parallel") {
            sys.addConstraintParallel(L(f("l1")), L(f("l2")), tag, drv);
            note(cid, type, MapClass::Direct, "addConstraintParallel");
        }
        else if (type == "perpendicular") {
            sys.addConstraintPerpendicular(L(f("l1")), L(f("l2")), tag, drv);
            note(cid, type, MapClass::Direct, "addConstraintPerpendicular(Line,Line)");
        }
        else if (type == "fix") {
            GCS::Point& p = P(f("point"));
            sys.addConstraintCoordinateX(p, param(s.x, false), tag, drv);
            sys.addConstraintCoordinateY(p, param(s.y, false), tag, drv);
            note(cid, type, MapClass::Direct, "addConstraintCoordinateX + addConstraintCoordinateY (one tag)");
        }
        else if (type == "midpoint") {
            GCS::Point& p = P(f("point"));
            if (has("line")) {
                GCS::Line& l = L(f("line"));
                sys.addConstraintP2PSymmetric(l.p1, l.p2, p, tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintP2PSymmetric(p1,p2,Point)");
            }
            else {
                GCS::Arc& a = arcs.at(f("arc"));
                sys.addConstraintPointOnArc(p, a, tag, drv);
                sys.addConstraintPointOnPerpBisector(p, a.start, a.end, tag, drv);
                note(cid, type, MapClass::Composed, "addConstraintPointOnArc + addConstraintPointOnPerpBisector(start,end)");
            }
        }
        else if (type == "concentric") {
            sys.addConstraintP2PCoincident(centerOf(f("a")), centerOf(f("b")), tag, drv);
            note(cid, type, MapClass::Composed, "addConstraintP2PCoincident on the centre points");
        }
        else if (type == "collinear") {
            GCS::Line& l1 = L(f("l1"));
            GCS::Line& l2 = L(f("l2"));
            sys.addConstraintPointOnLine(l2.p1, l1, tag, drv);
            sys.addConstraintPointOnLine(l2.p2, l1, tag, drv);
            note(cid, type, MapClass::Composed, "2x addConstraintPointOnLine (as Sketch.cpp:2925-2926)");
        }
        else if (type == "symmetric") {
            if (has("line")) {
                sys.addConstraintP2PSymmetric(P(f("p1")), P(f("p2")), L(f("line")), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintP2PSymmetric(p1,p2,Line)");
            }
            else {
                sys.addConstraintP2PSymmetric(P(f("p1")), P(f("p2")), P(f("center")), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintP2PSymmetric(p1,p2,Point)");
            }
        }
        else if (type == "curvature") {
            const std::string a = f("a"), b = f("b");
            const std::string ta = elementType.at(a), tb = elementType.at(b);
            auto round = [](const std::string& t) { return t == "arc" || t == "circle"; };
            if (round(ta) && round(tb)) {
                // G2 of two circular curves = same circle at the joint: tangent join + equal radius
                addJoinTangency(cid, tag, drv, a, b, f("p1"), f("p2"));
                if (ta == "arc" && tb == "arc") {
                    sys.addConstraintEqualRadius(arcs.at(a), arcs.at(b), tag, drv);
                }
                else if (ta == "circle" && tb == "circle") {
                    sys.addConstraintEqualRadius(circles.at(a), circles.at(b), tag, drv);
                }
                else {
                    const std::string c = ta == "circle" ? a : b, r = ta == "circle" ? b : a;
                    sys.addConstraintEqualRadius(circles.at(c), arcs.at(r), tag, drv);
                }
                note(cid, type, MapClass::Composed, "addConstraintP2PCoincident + addConstraintAngleViaPoint(locked) + addConstraintEqualRadius");
            }
            else if (ta == "line" || tb == "line") {
                throw Unsupported("curvature (G2) with a line needs an infinite radius on the other side; planegcs has no curvature constraint");
            }
            else if (gOwnConstraints && ((round(ta) && tb == "bspline") || (ta == "bspline" && round(tb)))) {
                const bool splineIsB = tb == "bspline";
                const std::string sId = splineIsB ? b : a, cId = splineIsB ? a : b;
                const std::string sPt = splineIsB ? f("p2") : f("p1");
                GCS::BSpline& bs = splines.at(sId);
                const json& poles = element(sId).at("poles");
                const bool atStart = poles.front().get<std::string>() == sPt;
                const bool atEnd = poles.back().get<std::string>() == sPt;
                if (bs.periodic || (atStart && bs.mult.front() <= bs.degree) || (atEnd && bs.mult.back() <= bs.degree) ||
                    (!atStart && !atEnd) || bs.degree < 2 || bs.poles.size() < 3) {
                    throw Unsupported("own curvature constraint only for the clamped end pole of an open B-spline of degree >= 2");
                }
                for (double* w : bs.weights) {
                    if (*w != *bs.weights.front()) {
                        throw Unsupported("own curvature constraint only for non-rational B-splines (equal weights)");
                    }
                }
                addJoinTangency(cid, tag, drv, a, b, f("p1"), f("p2"));
                GCS::Circle& circ = elementType.at(cId) == "arc" ? static_cast<GCS::Circle&>(arcs.at(cId)) : circles.at(cId);
                auto* own = new ConstraintEqualCurvatureCircleSplineEnd(circ, bs, atStart);
                own->setTag(tag);
                own->setDriving(drv);
                sys.addConstraint(own);
                note(cid, type, MapClass::Composed,
                     "addConstraintP2PCoincident + addConstraintAngleViaPoint(locked) + OWN ConstraintEqualCurvatureCircleSplineEnd "
                     "(subclass of GCS::Constraint in driver.cpp, not part of planegcs)");
            }
            else {
                throw Unsupported("curvature (G2) with a B-spline: planegcs has no curvature constraint (no 'curvature' in planegcs/ or Sketch.cpp); needs a new GCS::Constraint subclass");
            }
        }
        else if (type == "tangent_at_knot") {
            GCS::Line& l = L(f("line"));
            GCS::BSpline& b = splines.at(f("bspline"));
            const unsigned knot = k.at("knot").get<unsigned>();
            if (knot >= b.knots.size()) {
                throw Unsupported("knot index out of range");
            }
            if (b.mult[knot] >= b.degree) {
                // FreeCAD refuses this (Sketch.cpp:3080-3103); ConstraintSlopeAtBSplineKnot asserts
                // numpoles >= 2 (Constraints.cpp:268-270), which is false for mult == degree.
                throw Unsupported("tangent at a knot with multiplicity >= degree (slope discontinuous); FreeCAD refuses it, Sketch.cpp:3080-3103");
            }
            // FreeCAD's composition (Sketch.cpp:3105-3108): the knot point lies on the line and the
            // slope at the knot is parallel to the line. The knot point is an internal-alignment
            // helper point (as FreeCAD's knot point geometry), kept across rebuilds.
            GCS::DeriVector2 v = b.Value(*b.knots[knot], 0);
            GCS::Point kp(auxUnknown(cid + ".kx", v.x), auxUnknown(cid + ".ky", v.y));
            sys.addConstraintInternalAlignmentKnotPoint(b, kp, knot, tag, drv);
            sys.addConstraintPointOnLine(kp, l, tag, drv);
            sys.addConstraintTangentAtBSplineKnot(b, l, knot, tag, drv);
            note(cid, type, MapClass::Composed, "knot point (addConstraintInternalAlignmentKnotPoint) + addConstraintPointOnLine + addConstraintTangentAtBSplineKnot");
        }
        else if (type == "distance") {
            sys.addConstraintP2PDistance(P(f("p1")), P(f("p2")), valueParam(s, cid), tag, drv);
            note(cid, type, MapClass::Direct, "addConstraintP2PDistance");
        }
        else if (type == "distance_point_line") {
            sys.addConstraintP2LDistance(P(f("point")), L(f("line")), valueParam(s, cid), tag, drv);
            note(cid, type, MapClass::Direct, "addConstraintP2LDistance (unsigned)");
        }
        else if (type == "distance_x" || type == "distance_y") {
            GCS::Point& p1 = P(f("p1"));
            GCS::Point& p2 = P(f("p2"));
            const bool x = type == "distance_x";
            sys.addConstraintDifference(x ? p1.x : p1.y, x ? p2.x : p2.y, valueParam(s, cid), tag, drv);
            note(cid, type, MapClass::Direct, std::string("addConstraintDifference on the ") + (x ? "x" : "y") + " parameters");
        }
        else if (type == "length") {
            GCS::Line& l = L(f("line"));
            sys.addConstraintP2PDistance(l.p1, l.p2, valueParam(s, cid), tag, drv);
            note(cid, type, MapClass::Direct, "addConstraintP2PDistance on the end points");
        }
        else if (type == "angle") {
            sys.addConstraintL2LAngle(L(f("l1")), L(f("l2")), valueParam(s, cid), tag, drv);
            note(cid, type, MapClass::Direct, "addConstraintL2LAngle(Line,Line)");
        }
        else if (type == "angle_line") {
            GCS::Line& l = L(f("line"));
            // the 6-argument overload: the 5-argument one drops the tag (GCS.cpp:649-652)
            sys.addConstraintP2PAngle(l.p1, l.p2, valueParam(s, cid), 0.0, tag, drv);
            note(cid, type, MapClass::Direct, "addConstraintP2PAngle(p1,p2,angle,incr=0,tag) (6-argument overload)");
        }
        else if (type == "radius") {
            const std::string c = f("curve");
            if (elementType.at(c) == "circle") {
                sys.addConstraintCircleRadius(circles.at(c), valueParam(s, cid), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintCircleRadius");
            }
            else {
                sys.addConstraintArcRadius(arcs.at(c), valueParam(s, cid), tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintArcRadius");
            }
        }
        else if (type == "diameter") {
            const std::string c = f("curve");
            const bool freeRadius = unknownSet.count(radiusOf(c)) > 0;
            double* v = valueParam(s, cid, !s.driving && freeRadius);
            if (elementType.at(c) == "circle") {
                sys.addConstraintCircleDiameter(circles.at(c), v, tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintCircleDiameter");
            }
            else {
                sys.addConstraintArcDiameter(arcs.at(c), v, tag, drv);
                note(cid, type, MapClass::Direct, "addConstraintArcDiameter");
            }
        }
        else if (type == "arc_length") {
            sys.addConstraintArcLength(arcs.at(f("arc")), valueParam(s, cid), tag, drv);
            note(cid, type, MapClass::Direct, "addConstraintArcLength");
        }
        else {
            throw Unsupported("unknown constraint type " + type);
        }
    }
};

// ------------------------------------------------------------------------------------------------
// one solver run (pass 1) and one diagnosis (pass 2)
// ------------------------------------------------------------------------------------------------

struct SolveRun
{
    int status = GCS::Failed;
    Geometry geometry;
    json driven;
    json diagnosisAtStart;
    double msBuild = 0, msInit = 0, msSolve = 0, msTotal = 0;
    std::optional<int> iterations;
    bool sqp = false;
    bool anyComposed = false;
    std::vector<std::string> mapping;
};

// Count of the per-iteration log lines planegcs writes with debugMode == IterationLevel
// (GCS.cpp:2040, 2220, 2428). Summed over all decoupled subsystems of one solve() call.
int countIterations(const std::string& log)
{
    int n = 0;
    size_t pos = 0;
    while ((pos = log.find(", Iteration: ", pos)) != std::string::npos) {
        ++n;
        pos += 13;
    }
    return n;
}

SolveRun solveOnce(const json& c, const Geometry& g, const std::vector<CState>& st, const Drag* drag,
                   GCS::Algorithm alg, bool countIter)
{
    SolveRun r;
    auto t0 = Clock::now();
    Model m(c, g, st, drag);
    auto t1 = Clock::now();
    // FreeCAD runs initSolution with its "redundant" solver, DogLeg by default (Sketch.cpp:264)
    m.sys.initSolution(GCS::DogLeg);
    auto t2 = Clock::now();
    std::string log;
    if (countIter) {
        Base::Console().capture = &log;
        m.sys.debugMode = GCS::IterationLevel;
    }
    r.status = m.sys.solve(true, alg);
    if (countIter) {
        m.sys.debugMode = GCS::NoDebug;
        Base::Console().capture = nullptr;
        if (gVerbose) {
            std::cerr << "\n--- planegcs log, status " << statusName(r.status) << " ---\n" << log;
        }
    }
    auto t3 = Clock::now();
    // Best effort: the solution is applied also when the status is not Success, so that a
    // failed (conflicting) step can be diagnosed from its least-squares result. FreeCAD itself
    // only applies on Success (Sketch.cpp:4822-4827).
    m.sys.applySolution();
    auto t4 = Clock::now();
    r.msBuild = msSince(t0, t1);
    r.msInit = msSince(t1, t2);
    r.msSolve = msSince(t2, t3);
    r.msTotal = msSince(t0, t4);
    r.geometry = m.readBack();
    r.driven = m.drivenValues();
    r.diagnosisAtStart = m.diagnosis();
    r.sqp = m.hasAuxConstraints;
    r.anyComposed = m.anyComposed;
    r.mapping = m.mappingText;
    if (countIter && !r.sqp) {
        // the SQP path (System::solve(SubSystem*, SubSystem*), GCS.cpp:4502) writes no iteration log
        r.iterations = countIterations(log);
    }
    return r;
}

json diagnoseAt(const json& c, const Geometry& g, const std::vector<CState>& st)
{
    Model m(c, g, st, nullptr);
    m.sys.initSolution(GCS::DogLeg);
    return m.diagnosis();
}

json geometryJson(const json& c, const Geometry& g)
{
    json out = json::object();
    for (const auto& e : c.at("elements")) {
        const std::string id = jstr(e, "id");
        const std::string t = jstr(e, "type");
        if (t == "point") {
            const auto& p = g.points.at(id);
            out[id] = {{"x", p[0]}, {"y", p[1]}};
        }
        else if (t == "circle" || t == "arc") {
            out[id] = {{"radius", g.radius.at(id)}};
        }
    }
    return out;
}

std::optional<Drag> dragOfStep(const json& c, size_t k)
{
    if (k == 0 || !c.contains("steps")) {
        return std::nullopt;
    }
    const auto& s = c.at("steps")[k - 1];
    if (!s.contains("drag")) {
        return std::nullopt;
    }
    const auto& d = s.at("drag");
    return Drag {jstr(d, "point"), d.at("x").get<double>(), d.at("y").get<double>()};
}

// One complete pass over a case (all steps); returns per-step results.
struct StepResult
{
    SolveRun run;
    json diag;
};

std::vector<StepResult> runSequence(const json& c, GCS::Algorithm alg, bool countIter, bool withDiag)
{
    const size_t nSteps = c.contains("steps") ? c.at("steps").size() : 0;
    std::vector<StepResult> out;
    Geometry g = initialGeometry(c);
    for (size_t k = 0; k <= nSteps; ++k) {
        auto st = effectiveState(c, k);
        auto drag = dragOfStep(c, k);
        StepResult sr;
        sr.run = solveOnce(c, g, st, drag ? &*drag : nullptr, alg, countIter);
        g = sr.run.geometry;
        if (withDiag) {
            sr.diag = diagnoseAt(c, g, st);
        }
        out.push_back(std::move(sr));
    }
    return out;
}

json runCase(const json& c, const std::string& algName, int reps, double slowMs)
{
    const GCS::Algorithm alg = algorithmFromName(algName);
    json e;
    e["id"] = c.at("id");
    try {
        // warm-up (untimed): also the run that counts the iterations
        auto warm = runSequence(c, alg, true, false);
        double warmTotal = 0;
        for (const auto& s : warm) {
            warmTotal += s.run.msTotal;
        }
        const int n = warmTotal > slowMs ? 1 : reps;
        std::vector<std::vector<StepResult>> timed;
        for (int i = 0; i < n; ++i) {
            timed.push_back(runSequence(c, alg, false, i == n - 1));
        }
        const auto& last = timed.back();
        const size_t nSteps = last.size() - 1;

        auto medianOf = [&](size_t k, double SolveRun::* field) {
            std::vector<double> v;
            for (const auto& t : timed) {
                v.push_back(t[k].run.*field);
            }
            return median(v);
        };
        std::vector<double> totals;
        for (const auto& t : timed) {
            double s = 0;
            for (const auto& x : t) {
                s += x.run.msTotal;
            }
            totals.push_back(s);
        }

        const auto& fin = last.back();
        bool composed = false;
        for (const auto& s : last) {
            composed = composed || s.run.anyComposed;
        }
        std::set<std::string> mapSet;
        std::string mapping;
        for (const auto& s : last) {
            for (const auto& m : s.run.mapping) {
                if (mapSet.insert(m).second) {
                    mapping += (mapping.empty() ? "" : "; ") + m;
                }
            }
        }
        e["mapping"] = mapping.empty() ? "no constraints" : mapping;
        e["supported"] = composed ? "partial" : "yes";
        e["status"] = statusName(fin.run.status);
        e["algorithm"] = algName;
        e["iterations"] = warm.back().run.iterations ? json(*warm.back().run.iterations) : json(nullptr);
        e["time_ms_median"] = nSteps == 0 ? medianOf(0, &SolveRun::msTotal) : median(totals);
        e["dof"] = fin.diag.at("dof");
        e["conflicting"] = fin.diag.at("conflicting");
        e["redundant"] = fin.diag.at("redundant");
        e["partially_redundant"] = fin.diag.at("partially_redundant");
        e["geometry"] = geometryJson(c, fin.run.geometry);
        e["driven_values"] = fin.run.driven;
        e["diagnosis_at_start"] = last.front().run.diagnosisAtStart;
        if (nSteps == 0) {
            e["time_ms_parts"] = {{"build", medianOf(0, &SolveRun::msBuild)},
                                  {"init_solution_incl_diagnose", medianOf(0, &SolveRun::msInit)},
                                  {"solve", medianOf(0, &SolveRun::msSolve)}};
        }
        e["time_reps"] = n;
        json steps = json::array();
        if (nSteps > 0) {
            for (size_t k = 0; k <= nSteps; ++k) {
                const auto& s = last[k];
                json j;
                j["step"] = k;
                j["status"] = statusName(s.run.status);
                j["dof"] = s.diag.at("dof");
                j["conflicting"] = s.diag.at("conflicting");
                j["redundant"] = s.diag.at("redundant");
                j["partially_redundant"] = s.diag.at("partially_redundant");
                j["geometry"] = geometryJson(c, s.run.geometry);
                j["driven_values"] = s.run.driven;
                j["time_ms"] = medianOf(k, &SolveRun::msTotal);
                j["time_ms_solve"] = medianOf(k, &SolveRun::msSolve);
                j["iterations"] = warm[k].run.iterations ? json(*warm[k].run.iterations) : json(nullptr);
                steps.push_back(j);
            }
        }
        e["steps"] = steps;
        std::string notes;
        if (fin.run.sqp || (nSteps > 0 && std::any_of(last.begin(), last.end(), [](const StepResult& s) { return s.run.sqp; }))) {
            notes += "SQP path (non-driving or temporary constraints): planegcs logs no iterations there. ";
        }
        if (n != reps) {
            notes += "slow case: warm-up took " + std::to_string(int(warmTotal)) + " ms, so only " + std::to_string(n) + " timed run(s). ";
        }
        e["notes"] = notes;
    }
    catch (const Unsupported& u) {
        e["mapping"] = "not supported";
        e["supported"] = "no";
        e["status"] = "not supported";
        e["algorithm"] = algName;
        e["iterations"] = nullptr;
        e["time_ms_median"] = nullptr;
        e["dof"] = nullptr;
        e["conflicting"] = json::array();
        e["redundant"] = json::array();
        e["partially_redundant"] = json::array();
        e["geometry"] = json::object();
        e["driven_values"] = json::object();
        e["steps"] = json::array();
        e["notes"] = u.what();
    }
    return e;
}

std::string eigenVersion()
{
#ifdef EIGEN_VERSION_STRING
    return EIGEN_VERSION_STRING;
#else
    return std::to_string(EIGEN_WORLD_VERSION) + "." + std::to_string(EIGEN_MAJOR_VERSION) + "." +
        std::to_string(EIGEN_MINOR_VERSION);
#endif
}

std::string compilerVersion()
{
    std::ostringstream s;
    s << HCST_COMPILER_ID;
#if defined(__EMSCRIPTEN__)
    s << " (Emscripten " << __EMSCRIPTEN_MAJOR__ << "." << __EMSCRIPTEN_MINOR__ << "." << __EMSCRIPTEN_TINY__ << ")";
#elif defined(_MSC_FULL_VER)
    s << " (_MSC_FULL_VER " << _MSC_FULL_VER << ")";
#endif
    return s.str();
}

json loadCases(const std::string& file)
{
    std::ifstream in(file, std::ios::binary);
    if (!in) {
        throw std::runtime_error("cannot open " + file);
    }
    json doc = json::parse(in);
    std::string dir = file;
    size_t slash = dir.find_last_of("/\\");
    dir = slash == std::string::npos ? std::string(".") : dir.substr(0, slash);
    for (auto& c : doc.at("cases")) {
        if (c.contains("file")) {
            const std::string id = jstr(c, "id");
            std::ifstream f(dir + "/" + jstr(c, "file"), std::ios::binary);
            if (!f) {
                throw std::runtime_error("cannot open large case file " + jstr(c, "file"));
            }
            json full = json::parse(f);
            full["id"] = id;
            c = full;
        }
    }
    return doc;
}

}  // namespace

int main(int argc, char** argv)
{
    try {
        std::vector<std::string> pos;
        std::string track = HCST_TRACK_NAME, runtime = "not given", runDate = "not given";
        std::set<std::string> only;
        int reps = 5;
        double slowMs = 3000;
        for (int i = 1; i < argc; ++i) {
            std::string a = argv[i];
            auto next = [&]() -> std::string {
                if (i + 1 >= argc) {
                    throw std::runtime_error("missing value after " + a);
                }
                return argv[++i];
            };
            if (a == "--track") {
                track = next();
            }
            else if (a == "--runtime") {
                runtime = next();
            }
            else if (a == "--run-date") {
                runDate = next();
            }
            else if (a == "--reps") {
                reps = std::stoi(next());
            }
            else if (a == "--slow-ms") {
                slowMs = std::stod(next());
            }
            else if (a == "--verbose") {
                gVerbose = true;
            }
            else if (a == "--planegcs-only") {
                gOwnConstraints = false;
            }
            else if (a == "--only") {
                std::stringstream ss(next());
                std::string id;
                while (std::getline(ss, id, ',')) {
                    only.insert(id);
                }
            }
            else {
                pos.push_back(a);
            }
        }
        if (pos.size() != 2) {
            std::cerr << "usage: solvertest_driver <cases.json> <result.json> [--track t] [--runtime text] "
                         "[--run-date d] [--only id,id] [--reps n] [--slow-ms ms]\n";
            return 2;
        }
        json doc = loadCases(pos[0]);

        json res;
        res["track"] = track;
        res["solver"] = std::string("planegcs from FreeCAD ") + HCST_FREECAD_TAG + " (commit " + HCST_FREECAD_COMMIT +
            "), src/Mod/Sketcher/App/planegcs/{GCS,Constraints,Geo,SubSystem,qp_eq}.cpp built from source, unchanged";
        res["build"] = {
            {"compiler", compilerVersion()},
            {"flags", HCST_BUILD_FLAGS},
            {"eigen", eigenVersion()},
            {"boost", std::string("headers only, ") + BOOST_LIB_VERSION + " (BOOST_VERSION " + std::to_string(BOOST_VERSION) + ")"},
            {"other", "nlohmann/json " + std::to_string(NLOHMANN_JSON_VERSION_MAJOR) + "." +
                          std::to_string(NLOHMANN_JSON_VERSION_MINOR) + "." + std::to_string(NLOHMANN_JSON_VERSION_PATCH) +
                          " (driver only); shims native/shim/{Base/Console.h,FCConfig.h,QtCore.h}; no patches; "
                          "solver settings: GCS::System defaults (GCS.cpp:480-503), debugMode NoDebug; own constraint class "
                          "ConstraintEqualCurvatureCircleSplineEnd (driver.cpp, not planegcs) " +
                          std::string(gOwnConstraints ? "enabled" : "disabled (--planegcs-only)")}};
        res["runtime"] = runtime;
        res["run_date"] = runDate;
        res["timing_method"] = "std::chrono::steady_clock. Per case 1 untimed warm-up run (it also counts the iterations "
                               "with debugMode=IterationLevel), then " + std::to_string(reps) +
            " timed runs, median reported; a case whose warm-up took more than " + std::to_string(int(slowMs)) +
            " ms gets 1 timed run (see time_reps). Every run rebuilds the system from the start geometry. "
            "time_ms_median = pass 1 only: build of the GCS::System + initSolution (includes diagnose) + solve + "
            "applySolution; time_ms_parts splits it. For step cases time_ms_median is the median of the summed pass-1 "
            "times of all steps, steps[].time_ms the per-step median. Pass 2 (diagnosis from the solved geometry) is not timed.";
        json cases = json::array();
        for (const auto& c : doc.at("cases")) {
            const std::string id = jstr(c, "id");
            if (!only.empty() && !only.count(id)) {
                continue;
            }
            std::vector<std::string> algs;
            if (c.contains("run_algorithms") && !c.at("run_algorithms").empty()) {
                for (const auto& a : c.at("run_algorithms")) {
                    algs.push_back(a.get<std::string>());
                }
            }
            else {
                algs.push_back("DogLeg");
            }
            for (const auto& a : algs) {
                std::cerr << id << " [" << a << "] ... " << std::flush;
                auto t0 = Clock::now();
                json e = runCase(c, a, reps, slowMs);
                std::cerr << e.at("status").get<std::string>() << " (" << int(msSince(t0, Clock::now())) << " ms wall)\n";
                cases.push_back(e);
            }
        }
        res["cases"] = cases;
        std::ofstream out(pos[1], std::ios::binary);
        if (!out) {
            throw std::runtime_error("cannot write " + pos[1]);
        }
        out << res.dump(1) << "\n";
        return 0;
    }
    catch (const std::exception& ex) {
        std::cerr << "error: " << ex.what() << "\n";
        return 1;
    }
}
