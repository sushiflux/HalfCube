#include "model.hpp"

#include <BRepAdaptor_Curve.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeShape.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepCheck.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_Result.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepGProp.hxx>
#include <BRepLib.hxx>
#include <BRepOffsetAPI_MakePipeShell.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <Geom2d_Line.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <Message_ProgressIndicator.hxx>
#include <Message_ProgressScope.hxx>
#include <NCollection_IndexedMap.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <gp_Ax2.hxx>
#include <gp_Ax3.hxx>
#include <gp_Circ.hxx>
#include <gp_Dir2d.hxx>
#include <gp_Pnt2d.hxx>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <set>
#include <sstream>

namespace pc {

namespace {

constexpr double kPi = 3.14159265358979323846;
using ShapeMap = NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>;
using Clock = std::chrono::steady_clock;

double msSince(Clock::time_point t0) { return std::chrono::duration<double, std::milli>(Clock::now() - t0).count(); }

// Number for messages: short, without trailing zeros.
std::string fmt(double v) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.6g", v);
    return buf;
}

std::string canon(double v) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.17g", v);
    return buf;
}

std::string describeCurrentException() {
    try {
        throw;
    } catch (const Standard_Failure& e) {
        return std::string(e.ExceptionType()) + ": " + (e.what() ? e.what() : "");
    } catch (const std::exception& e) {
        return std::string("std::exception: ") + e.what();
    } catch (...) {
        return "unknown exception";
    }
}

// OCCT progress indicator that only forwards our cancel check, so long kernel operations stop early.
class CancelIndicator : public Message_ProgressIndicator {
public:
    explicit CancelIndicator(const Model::CancelFn& fn) : fn_(fn) {}
    bool UserBreak() override { return fn_ && fn_(); }
    void Show(const Message_ProgressScope&, const bool) override {}

private:
    const Model::CancelFn& fn_;
};

// ---------------------------------------------------------------- recipe parsing

const std::set<std::string> kStepTypes = {"box", "hole", "fillet", "spring", "debug.spin"};

void checkValue(const Json* v, const std::string& p, const std::map<std::string, double>& params) {
    if (!v) throw RecipeError(p + ": missing");
    if (v->isNumber()) {
        if (!std::isfinite(v->number())) throw RecipeError(p + ": must be a finite number");
        return;
    }
    if (v->isString()) {
        if (!params.count(v->str())) throw RecipeError(p + ": unknown parameter \"" + v->str() + "\"");
        return;
    }
    throw RecipeError(p + ": must be a number or the name of a parameter, got " + Json::typeName(v->type()));
}

void requireValue(const Json& step, const char* key, const std::string& path, const std::map<std::string, double>& params) {
    checkValue(step.find(key), path + "." + key, params);
}

void requireValueArray(const Json& step, const char* key, size_t n, const std::string& path,
                       const std::map<std::string, double>& params) {
    const Json* v = step.find(key);
    const std::string p = path + "." + key;
    if (!v) throw RecipeError(p + ": missing");
    if (!v->isArray() || v->size() != n)
        throw RecipeError(p + ": must be an array of " + std::to_string(n) + " values");
    for (size_t i = 0; i < n; ++i) checkValue(&v->items()[i], p + "[" + std::to_string(i) + "]", params);
}

void requireString(const Json& step, const char* key, const std::string& path) {
    const Json* v = step.find(key);
    if (!v) throw RecipeError(path + "." + key + ": missing");
    if (!v->isString() || v->str().empty()) throw RecipeError(path + "." + key + ": must be a non-empty string");
}

void allowOnly(const Json& step, std::initializer_list<const char*> keys, const std::string& path) {
    for (const auto& kv : step.members()) {
        bool ok = false;
        for (const char* k : keys) ok = ok || kv.first == k;
        if (!ok) throw RecipeError(path + "." + kv.first + ": unknown field");
    }
}

} // namespace

Recipe parseRecipe(const Json& j, bool allowDebugSteps) {
    if (!j.isObject()) throw RecipeError("recipe: must be an object");
    const Json* fmtv = j.find("format");
    if (!fmtv || !fmtv->isString() || fmtv->str() != "partcraft.recipe")
        throw RecipeError("recipe.format: must be \"partcraft.recipe\"");
    const Json* ver = j.find("formatVersion");
    if (!ver || !ver->isNumber() || ver->number() != 0) throw RecipeError("recipe.formatVersion: must be 0");
    for (const auto& kv : j.members())
        if (kv.first != "format" && kv.first != "formatVersion" && kv.first != "parameters" && kv.first != "steps")
            throw RecipeError("recipe." + kv.first + ": unknown field");

    Recipe r;
    r.raw = j;
    const Json* params = j.find("parameters");
    if (!params || !params->isObject()) throw RecipeError("recipe.parameters: must be an object");
    for (const auto& kv : params->members()) {
        if (kv.first.empty()) throw RecipeError("recipe.parameters: empty parameter name");
        if (!kv.second.isNumber() || !std::isfinite(kv.second.number()))
            throw RecipeError("recipe.parameters." + kv.first + ": must be a finite number");
        r.params[kv.first] = kv.second.number();
    }

    const Json* steps = j.find("steps");
    if (!steps || !steps->isArray()) throw RecipeError("recipe.steps: must be an array");
    std::map<std::string, std::string> bodyCreator;        // body -> step id that created it
    std::map<std::string, std::string> holeBody;           // hole step id -> body
    std::set<std::string> ids;
    for (size_t i = 0; i < steps->size(); ++i) {
        const Json& s = steps->items()[i];
        const std::string path = "recipe.steps[" + std::to_string(i) + "]";
        if (!s.isObject()) throw RecipeError(path + ": must be an object");
        requireString(s, "id", path);
        requireString(s, "type", path);
        StepDef d;
        d.id = s.find("id")->str();
        d.type = s.find("type")->str();
        d.raw = s;
        if (!ids.insert(d.id).second) throw RecipeError(path + ".id: duplicate step id \"" + d.id + "\"");
        if (!kStepTypes.count(d.type)) throw RecipeError(path + ".type: unknown step type \"" + d.type + "\"");
        {
            if (d.type == "debug.spin") {
                if (!allowDebugSteps) throw RecipeError(path + ".type: \"debug.spin\" needs debug commands enabled");
                allowOnly(s, {"id", "type", "ms"}, path);
                requireValue(s, "ms", path, r.params);
                r.steps.push_back(std::move(d));
                continue;
            }
            requireString(s, "body", path);
            d.body = s.find("body")->str();
            const bool creates = d.type == "box" || d.type == "spring";
            if (creates) {
                auto it = bodyCreator.find(d.body);
                if (it != bodyCreator.end())
                    throw RecipeError(path + ".body: body \"" + d.body + "\" is already created by step \"" + it->second + "\"");
                bodyCreator[d.body] = d.id;
            } else if (!bodyCreator.count(d.body)) {
                throw RecipeError(path + ".body: body \"" + d.body + "\" does not exist before this step");
            }
            if (d.type == "box") {
                allowOnly(s, {"id", "type", "body", "origin", "size"}, path);
                requireValueArray(s, "origin", 3, path, r.params);
                requireValueArray(s, "size", 3, path, r.params);
            } else if (d.type == "hole") {
                allowOnly(s, {"id", "type", "body", "center", "diameter"}, path);
                requireValueArray(s, "center", 2, path, r.params);
                requireValue(s, "diameter", path, r.params);
                holeBody[d.id] = d.body;
            } else if (d.type == "fillet") {
                allowOnly(s, {"id", "type", "body", "edges", "radius"}, path);
                requireValue(s, "radius", path, r.params);
                const Json* e = s.find("edges");
                if (!e || !e->isObject()) throw RecipeError(path + ".edges: must be an object");
                allowOnly(*e, {"selector", "hole"}, path + ".edges");
                const Json* sel = e->find("selector");
                if (!sel || !sel->isString() || sel->str() != "holeTopEdge")
                    throw RecipeError(path + ".edges.selector: must be \"holeTopEdge\"");
                requireString(*e, "hole", path + ".edges");
                const std::string hole = e->find("hole")->str();
                auto hb = holeBody.find(hole);
                if (hb == holeBody.end())
                    throw RecipeError(path + ".edges.hole: \"" + hole + "\" is not an earlier hole step");
                if (hb->second != d.body)
                    throw RecipeError(path + ".edges.hole: hole \"" + hole + "\" belongs to body \"" + hb->second + "\", not \"" + d.body + "\"");
            } else if (d.type == "spring") {
                allowOnly(s, {"id", "type", "body", "radius", "pitch", "turns", "wireDiameter"}, path);
                for (const char* k : {"radius", "pitch", "turns", "wireDiameter"}) requireValue(s, k, path, r.params);
            }
        }
        r.steps.push_back(std::move(d));
    }
    return r;
}

Json StepStatus::toJson() const {
    Json j = Json::object();
    j["stepId"] = stepId;
    j["type"] = type;
    j["status"] = status;
    j["message"] = message;
    j["cached"] = cached;
    j["ms"] = ms;
    if (hasCheck) {
        Json c = Json::object();
        c["valid"] = check.valid;
        c["volume"] = check.volume;
        c["faces"] = check.faces;
        c["solids"] = check.solids;
        j["check"] = c;
    }
    return j;
}

uint64_t fnv1a64(const std::string& s, uint64_t h) {
    for (unsigned char c : s) {
        h ^= c;
        h *= 1099511628211ull;
    }
    return h;
}

namespace {

// ---------------------------------------------------------------- geometry helpers

struct Resolver {
    const std::map<std::string, double>& params;
    double operator()(const Json& v) const { return v.isNumber() ? v.number() : params.at(v.str()); }
    double at(const Json& step, const char* key) const { return (*this)(*step.find(key)); }
    double at(const Json& step, const char* key, size_t i) const { return (*this)(step.find(key)->items()[i]); }
};

int countShapes(const TopoDS_Shape& s, TopAbs_ShapeEnum t) {
    ShapeMap m;
    TopExp::MapShapes(s, t, m);
    return m.Extent();
}

double volumeOf(const TopoDS_Shape& s) {
    GProp_GProps p;
    BRepGProp::VolumeProperties(s, p);
    return p.Mass();
}

const char* shapeTypeName(TopAbs_ShapeEnum t) {
    switch (t) {
    case TopAbs_VERTEX: return "vertex";
    case TopAbs_EDGE: return "edge";
    case TopAbs_WIRE: return "wire";
    case TopAbs_FACE: return "face";
    case TopAbs_SHELL: return "shell";
    case TopAbs_SOLID: return "solid";
    default: return "shape";
    }
}

// Runs BRepCheck_Analyzer and fills the step check. Returns "" when valid, otherwise the faults found
// (sub-shape and BRepCheck status, at most 20 entries).
std::string checkShape(const TopoDS_Shape& s, StepStatus& st) {
    BRepCheck_Analyzer ana(s);
    st.hasCheck = true;
    st.check.valid = ana.IsValid();
    st.check.volume = volumeOf(s);
    st.check.faces = countShapes(s, TopAbs_FACE);
    st.check.solids = countShapes(s, TopAbs_SOLID);
    if (st.check.valid) return "";
    std::string out;
    int listed = 0;
    for (TopAbs_ShapeEnum t : {TopAbs_VERTEX, TopAbs_EDGE, TopAbs_WIRE, TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID}) {
        ShapeMap m;
        TopExp::MapShapes(s, t, m);
        for (int i = 1; i <= m.Extent() && listed < 20; ++i) {
            if (ana.IsValid(m(i))) continue;
            const auto& res = ana.Result(m(i));
            if (res.IsNull()) continue;
            std::ostringstream os;
            for (auto code : res->Status())
                if (code != BRepCheck_NoError) BRepCheck::Print(code, os);
            for (res->InitContextIterator(); res->MoreShapeInContext(); res->NextShapeInContext())
                for (auto code : res->StatusOnShape())
                    if (code != BRepCheck_NoError) BRepCheck::Print(code, os);
            std::string txt = os.str();
            std::replace(txt.begin(), txt.end(), '\n', ' ');
            while (!txt.empty() && txt.back() == ' ') txt.pop_back();
            if (txt.empty()) continue;
            if (!out.empty()) out += "; ";
            out += std::string(shapeTypeName(t)) + " " + std::to_string(i) + ": " + txt;
            ++listed;
        }
    }
    return out.empty() ? "BRepCheck_Analyzer reports the shape as invalid without sub-shape details" : out;
}

// Carries the face origins through a modifying operation: modified and unchanged faces keep their origin,
// faces without history (new faces) get this step's id.
FaceOrigins propagateOrigins(BRepBuilderAPI_MakeShape& algo, const TopoDS_Shape& before, const FaceOrigins& old,
                             const TopoDS_Shape& after, const std::string& stepId) {
    FaceOrigins tmp;
    for (TopExp_Explorer ex(before, TopAbs_FACE); ex.More(); ex.Next()) {
        const TopoDS_Shape& f = ex.Current();
        const std::string* o = old.Seek(f);
        if (!o) continue;
        for (const auto& m : algo.Modified(f))
            if (m.ShapeType() == TopAbs_FACE && !tmp.IsBound(m)) tmp.Bind(m, *o);
        if (!algo.IsDeleted(f) && !tmp.IsBound(f)) tmp.Bind(f, *o);
    }
    FaceOrigins out;
    for (TopExp_Explorer ex(after, TopAbs_FACE); ex.More(); ex.Next()) {
        const TopoDS_Shape& f = ex.Current();
        if (out.IsBound(f)) continue;
        const std::string* o = tmp.Seek(f);
        out.Bind(f, o ? *o : stepId);
    }
    return out;
}

FaceOrigins allFacesFrom(const TopoDS_Shape& s, const std::string& stepId) {
    FaceOrigins out;
    for (TopExp_Explorer ex(s, TopAbs_FACE); ex.More(); ex.Next())
        if (!out.IsBound(ex.Current())) out.Bind(ex.Current(), stepId);
    return out;
}

// Shared result of one geometric step.
struct StepGeom {
    TopoDS_Shape shape;
    FaceOrigins origins;
};

// Finds the circular edge where a vertical hole of diameter d around (cx, cy) meets the top of the body.
bool findHoleTopEdge(const TopoDS_Shape& body, double cx, double cy, double d, TopoDS_Edge& out) {
    double bestZ = -1e300;
    bool found = false;
    for (TopExp_Explorer ex(body, TopAbs_EDGE); ex.More(); ex.Next()) {
        const TopoDS_Edge& e = TopoDS::Edge(ex.Current());
        BRepAdaptor_Curve c(e);
        if (c.GetType() != GeomAbs_Circle) continue;
        const gp_Circ ci = c.Circle();
        if (std::abs(ci.Radius() - d / 2) > 1e-6) continue;
        if (std::abs(ci.Location().X() - cx) > 1e-6 || std::abs(ci.Location().Y() - cy) > 1e-6) continue;
        if (std::abs(std::abs(ci.Axis().Direction().Z()) - 1.0) > 1e-9) continue;
        if (ci.Location().Z() > bestZ) {
            bestZ = ci.Location().Z();
            out = e;
            found = true;
        }
    }
    return found;
}

double edgeLength(const TopoDS_Shape& e) {
    GProp_GProps p;
    BRepGProp::LinearProperties(e, p);
    return p.Mass();
}

// Each step function returns the new body state or throws StepFailure with the full message.
struct StepFailure {
    std::string message;
};

StepGeom stepBox(const StepDef& d, const Resolver& R, StepStatus& st) {
    const double ox = R.at(d.raw, "origin", 0), oy = R.at(d.raw, "origin", 1), oz = R.at(d.raw, "origin", 2);
    const double sx = R.at(d.raw, "size", 0), sy = R.at(d.raw, "size", 1), sz = R.at(d.raw, "size", 2);
    if (sx <= 0 || sy <= 0 || sz <= 0)
        throw StepFailure{"Box \"" + d.id + "\": every size must be greater than 0 mm, got " + fmt(sx) + " x " +
                          fmt(sy) + " x " + fmt(sz) + " mm."};
    BRepPrimAPI_MakeBox mk(gp_Pnt(ox, oy, oz), gp_Pnt(ox + sx, oy + sy, oz + sz));
    StepGeom g;
    g.shape = mk.Shape();
    g.origins = allFacesFrom(g.shape, d.id);
    const std::string faults = checkShape(g.shape, st);
    if (!faults.empty()) throw StepFailure{"Box \"" + d.id + "\" is invalid: " + faults};
    const double expected = sx * sy * sz;
    if (std::abs(st.check.volume - expected) > 1e-9 * expected)
        throw StepFailure{"Box \"" + d.id + "\": volume " + fmt(st.check.volume) + " mm3 differs from the expected " +
                          fmt(expected) + " mm3."};
    return g;
}

StepGeom stepHole(const StepDef& d, const Resolver& R, const BodyOut& body, const Model::CancelFn& cancelled,
                  StepStatus& st) {
    const double cx = R.at(d.raw, "center", 0), cy = R.at(d.raw, "center", 1), dia = R.at(d.raw, "diameter");
    if (dia <= 0) throw StepFailure{"Hole \"" + d.id + "\": the diameter must be greater than 0 mm, got " + fmt(dia) + " mm."};
    Bnd_Box bb;
    BRepBndLib::AddOptimal(body.shape, bb, false, false);
    double x0, y0, z0, x1, y1, z1;
    bb.Get(x0, y0, z0, x1, y1, z1);
    // The tool overshoots the body by 1 mm at both ends so the cut is unambiguous.
    const double h = (z1 - z0) + 2.0;
    const TopoDS_Shape tool = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(cx, cy, z0 - 1.0), gp::DZ(), gp::DX()), dia / 2, h).Shape();
    occ::handle<CancelIndicator> ind = new CancelIndicator(cancelled);
    BRepAlgoAPI_Cut cut(body.shape, tool, ind->Start());
    if (cancelled && cancelled()) throw Cancelled{};
    if (cut.HasErrors() || !cut.IsDone()) {
        std::ostringstream os;
        cut.DumpErrors(os);
        std::string txt = os.str();
        std::replace(txt.begin(), txt.end(), '\n', ' ');
        throw StepFailure{"Hole \"" + d.id + "\": the boolean cut failed: " + (txt.empty() ? "no details from OCCT" : txt)};
    }
    StepGeom g;
    g.shape = cut.Shape();
    g.origins = propagateOrigins(cut, body.shape, body.origins, g.shape, d.id);
    const double vBefore = volumeOf(body.shape);
    const std::string faults = checkShape(g.shape, st);
    if (!faults.empty()) throw StepFailure{"Hole \"" + d.id + "\" produced an invalid solid: " + faults};
    if (st.check.solids != 1)
        throw StepFailure{"Hole \"" + d.id + "\" split body \"" + d.body + "\" into " + std::to_string(st.check.solids) + " solids."};
    // Plausibility: a cut cannot add material and cannot remove more than the tool's volume.
    const double removed = vBefore - st.check.volume;
    const double maxRemoved = kPi * dia * dia / 4 * h;
    const double eps = 1e-7 * std::max(1.0, vBefore);
    if (removed < -eps || removed > maxRemoved + eps)
        throw StepFailure{"Hole \"" + d.id + "\": implausible volume change, " + fmt(vBefore) + " -> " +
                          fmt(st.check.volume) + " mm3 (allowed removal 0 to " + fmt(maxRemoved) + " mm3)."};
    if (removed <= eps) {
        st.status = "warning";
        st.message = "Hole \"" + d.id + "\" at (" + fmt(cx) + ", " + fmt(cy) + ") with diameter " + fmt(dia) +
                     " mm does not touch body \"" + d.body + "\"; nothing was removed.";
    }
    std::ostringstream ws;
    if (cut.HasWarnings()) {
        cut.DumpWarnings(ws);
        std::string txt = ws.str();
        std::replace(txt.begin(), txt.end(), '\n', ' ');
        if (!txt.empty()) {
            st.status = "warning";
            st.message += (st.message.empty() ? "" : " ") + std::string("OCCT warnings: ") + txt;
        }
    }
    return g;
}

const char* stripeStatusName(ChFiDS_ErrorStatus s) {
    switch (s) {
    case ChFiDS_Ok: return "Ok";
    case ChFiDS_Error: return "Error";
    case ChFiDS_WalkingFailure: return "WalkingFailure";
    case ChFiDS_StartsolFailure: return "StartsolFailure";
    case ChFiDS_TwistedSurface: return "TwistedSurface";
    default: return "?";
    }
}

StepGeom stepFillet(const StepDef& d, const Resolver& R, const BodyOut& body, const Recipe& recipe,
                    const Model::CancelFn& cancelled, StepStatus& st) {
    const double r = R.at(d.raw, "radius");
    const std::string holeId = d.raw.find("edges")->find("hole")->str();
    if (r <= 0) throw StepFailure{"Fillet \"" + d.id + "\": the radius must be greater than 0 mm, got " + fmt(r) + " mm."};
    const StepDef* hole = nullptr;
    for (const auto& s : recipe.steps) if (s.id == holeId) hole = &s;
    const double cx = R.at(hole->raw, "center", 0), cy = R.at(hole->raw, "center", 1), dia = R.at(hole->raw, "diameter");
    TopoDS_Edge edge;
    if (!findHoleTopEdge(body.shape, cx, cy, dia, edge))
        throw StepFailure{"Fillet \"" + d.id + "\": the top edge of hole \"" + holeId + "\" was not found on body \"" +
                          d.body + "\" (no circular edge of radius " + fmt(dia / 2) + " mm around (" + fmt(cx) + ", " +
                          fmt(cy) + "))."};
    BRepFilletAPI_MakeFillet mk(body.shape);
    mk.Add(r, edge);
    occ::handle<CancelIndicator> ind = new CancelIndicator(cancelled);
    try {
        mk.Build(ind->Start());
    } catch (...) {
        if (cancelled && cancelled()) throw Cancelled{};
        throw StepFailure{"Fillet \"" + d.id + "\" with radius " + fmt(r) + " mm failed in OCCT: " + describeCurrentException()};
    }
    if (cancelled && cancelled()) throw Cancelled{};
    if (!mk.IsDone()) {
        std::string stripes;
        for (int i = 1; i <= mk.NbContours(); ++i) stripes += (i > 1 ? ", " : "") + std::string(stripeStatusName(mk.StripeStatus(i)));
        throw StepFailure{"Fillet \"" + d.id + "\" with radius " + fmt(r) + " mm on the top edge of hole \"" + holeId +
                          "\" could not be built (OCCT: IsDone() == false, faulty contours " +
                          std::to_string(mk.NbFaultyContours()) + ", stripe status " + (stripes.empty() ? "none" : stripes) +
                          "). The radius is probably too large for the neighbouring faces."};
    }
    StepGeom g;
    g.shape = mk.Shape();
    g.origins = propagateOrigins(mk, body.shape, body.origins, g.shape, d.id);
    const double vBefore = volumeOf(body.shape);
    const std::string faults = checkShape(g.shape, st);
    if (!faults.empty())
        throw StepFailure{"Fillet \"" + d.id + "\" with radius " + fmt(r) + " mm produced an invalid solid (OCCT reported "
                          "success): " + faults};
    if (st.check.solids != 1)
        throw StepFailure{"Fillet \"" + d.id + "\" produced " + std::to_string(st.check.solids) + " solids instead of one."};
    // Plausibility: a constant fillet changes the volume by less than its cross-section bound r^2 per unit
    // of edge length ((1 - pi/4) r^2 is the exact cross-section on a 90-degree edge).
    const double bound = edgeLength(edge) * r * r;
    const double change = std::abs(st.check.volume - vBefore);
    if (!(change <= bound) || !(st.check.volume > 0))
        throw StepFailure{"Fillet \"" + d.id + "\": implausible volume change, " + fmt(vBefore) + " -> " +
                          fmt(st.check.volume) + " mm3 (at most " + fmt(bound) + " mm3 expected)."};
    return g;
}

StepGeom stepSpring(const StepDef& d, const Resolver& R, const Model::CancelFn& cancelled, StepStatus& st) {
    const double rad = R.at(d.raw, "radius"), pitch = R.at(d.raw, "pitch"), turns = R.at(d.raw, "turns"),
                 wire = R.at(d.raw, "wireDiameter");
    if (rad <= 0 || pitch <= 0 || turns <= 0 || wire <= 0)
        throw StepFailure{"Spring \"" + d.id + "\": radius, pitch, turns and wire diameter must be greater than 0, got " +
                          fmt(rad) + ", " + fmt(pitch) + ", " + fmt(turns) + ", " + fmt(wire) + "."};
    if (wire >= pitch)
        throw StepFailure{"Spring \"" + d.id + "\": the wire diameter (" + fmt(wire) + " mm) must be smaller than the pitch (" +
                          fmt(pitch) + " mm), otherwise the turns overlap."};
    if (wire / 2 >= rad)
        throw StepFailure{"Spring \"" + d.id + "\": the wire radius (" + fmt(wire / 2) + " mm) must be smaller than the spring radius (" +
                          fmt(rad) + " mm)."};
    // Helix as a 2D line on a cylinder: u is the angle, v the height; one turn is (2 pi, pitch).
    occ::handle<Geom_CylindricalSurface> cyl = new Geom_CylindricalSurface(gp_Ax3(gp_Pnt(0, 0, 0), gp::DZ(), gp::DX()), rad);
    occ::handle<Geom2d_Line> line = new Geom2d_Line(gp_Pnt2d(0, 0), gp_Dir2d(2 * kPi, pitch));
    const double len2d = turns * std::hypot(2 * kPi, pitch);
    TopoDS_Edge e = BRepBuilderAPI_MakeEdge(line, cyl, 0.0, len2d).Edge();
    BRepLib::BuildCurves3d(e, 1e-7, GeomAbs_C2, 14, 200);
    const TopoDS_Wire spine = BRepBuilderAPI_MakeWire(e).Wire();
    const gp_Vec tangent(0.0, rad, pitch / (2 * kPi));
    const TopoDS_Wire profile =
        BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(gp_Circ(gp_Ax2(gp_Pnt(rad, 0, 0), gp_Dir(tangent)), wire / 2)).Edge()).Wire();
    BRepOffsetAPI_MakePipeShell mk(spine);
    mk.SetMode(true);  // Frenet, as chosen in the kernel test
    mk.Add(profile, false, false);
    occ::handle<CancelIndicator> ind = new CancelIndicator(cancelled);
    try {
        mk.Build(ind->Start());
    } catch (...) {
        if (cancelled && cancelled()) throw Cancelled{};
        throw StepFailure{"Spring \"" + d.id + "\": the sweep failed in OCCT: " + describeCurrentException()};
    }
    if (cancelled && cancelled()) throw Cancelled{};
    if (!mk.IsDone()) throw StepFailure{"Spring \"" + d.id + "\": the sweep could not be built (OCCT: IsDone() == false)."};
    if (!mk.MakeSolid()) throw StepFailure{"Spring \"" + d.id + "\": the swept shell could not be closed into a solid."};
    StepGeom g;
    g.shape = mk.Shape();
    g.origins = allFacesFrom(g.shape, d.id);
    const std::string faults = checkShape(g.shape, st);
    if (!faults.empty()) throw StepFailure{"Spring \"" + d.id + "\" produced an invalid solid: " + faults};
    // Plausibility (Pappus): wire cross-section times the helix length, within 1 %.
    const double expected = kPi * wire * wire / 4 * turns * std::hypot(2 * kPi * rad, pitch);
    if (std::abs(st.check.volume - expected) > 0.01 * expected)
        throw StepFailure{"Spring \"" + d.id + "\": implausible volume " + fmt(st.check.volume) + " mm3, expected about " +
                          fmt(expected) + " mm3."};
    return g;
}

void stepSpin(const StepDef& d, const Resolver& R, const Model::CancelFn& cancelled) {
    const double ms = R.at(d.raw, "ms");
    const auto t0 = Clock::now();
    while (msSince(t0) < ms) {
        if (cancelled && cancelled()) throw Cancelled{};
        const auto t1 = Clock::now();
        while (msSince(t1) < 1.0) {}  // busy on purpose: simulates kernel work that cannot yield
    }
}

// Canonical text of a step's resolved inputs, for the cache key.
std::string canonicalInputs(const StepDef& d, const Resolver& R, const Recipe& recipe) {
    std::string s = d.type + "|" + d.body;
    auto add = [&](double v) { s += "|" + canon(v); };
    if (d.type == "box") {
        for (size_t i = 0; i < 3; ++i) add(R.at(d.raw, "origin", i));
        for (size_t i = 0; i < 3; ++i) add(R.at(d.raw, "size", i));
    } else if (d.type == "hole") {
        add(R.at(d.raw, "center", 0)); add(R.at(d.raw, "center", 1)); add(R.at(d.raw, "diameter"));
    } else if (d.type == "fillet") {
        add(R.at(d.raw, "radius"));
        const std::string holeId = d.raw.find("edges")->find("hole")->str();
        s += "|hole:" + holeId;
        for (const auto& h : recipe.steps)
            if (h.id == holeId) { add(R.at(h.raw, "center", 0)); add(R.at(h.raw, "center", 1)); add(R.at(h.raw, "diameter")); }
    } else if (d.type == "spring") {
        for (const char* k : {"radius", "pitch", "turns", "wireDiameter"}) add(R.at(d.raw, k));
    } else if (d.type == "debug.spin") {
        add(R.at(d.raw, "ms"));
    }
    return s;
}

} // namespace

RebuildOut Model::rebuild(const Recipe& recipe, const CancelFn& cancelled, const StepDoneFn& stepDone) {
    struct BodyState {
        BodyOut out;
        bool hasShape = false;
        std::string failedStep;  // first failing step; later steps on this body are skipped
    };
    std::map<std::string, BodyState> bodies;
    std::vector<std::string> bodyOrder;
    const Resolver R{recipe.params};
    RebuildOut res;
    bool anyError = false, anyWarning = false;

    for (size_t i = 0; i < recipe.steps.size(); ++i) {
        if (cancelled && cancelled()) throw Cancelled{};
        const StepDef& d = recipe.steps[i];
        const auto t0 = Clock::now();
        StepStatus st;
        st.stepId = d.id;
        st.type = d.type;
        if (d.type == "debug.spin") {
            stepSpin(d, R, cancelled);
            st.ms = msSince(t0);
            res.steps.push_back(st);
            if (stepDone) stepDone(i, st);
            continue;
        }
        const bool creates = d.type == "box" || d.type == "spring";
        if (creates && !bodies.count(d.body)) {
            bodies[d.body].out.bodyId = d.body;
            bodyOrder.push_back(d.body);
        }
        BodyState& b = bodies[d.body];
        if (!b.failedStep.empty()) {
            st.status = "skipped";
            st.message = "Skipped because step \"" + b.failedStep + "\" failed earlier on body \"" + d.body + "\".";
        } else {
            const uint64_t key = fnv1a64(canonicalInputs(d, R, recipe), creates ? 1469598103934665603ull : b.out.key);
            auto it = cache_.find(d.id);
            if (it != cache_.end() && it->second.key == key && it->second.status.type == d.type) {
                st = it->second.status;
                st.cached = true;
                if (it->second.hasShape) {
                    b.out.shape = it->second.shape;
                    b.out.origins = it->second.origins;
                    b.out.key = key;
                    b.out.lastStepId = d.id;
                    b.hasShape = true;
                }
            } else {
                CacheEntry ce;
                ce.key = key;
                StepGeom g;
                bool ok = false;
                try {
                    if (d.type == "box") g = stepBox(d, R, st);
                    else if (d.type == "spring") g = stepSpring(d, R, cancelled, st);
                    else if (d.type == "hole") g = stepHole(d, R, b.out, cancelled, st);
                    else if (d.type == "fillet") g = stepFillet(d, R, b.out, recipe, cancelled, st);
                    ok = true;
                } catch (const StepFailure& f) {
                    st.status = "error";
                    st.message = f.message;
                } catch (const Cancelled&) {
                    throw;
                } catch (...) {
                    if (cancelled && cancelled()) throw Cancelled{};
                    st.status = "error";
                    st.message = "Step \"" + d.id + "\" (" + d.type + ") failed with an unexpected kernel exception: " +
                                 describeCurrentException();
                }
                st.ms = msSince(t0);
                ce.status = st;
                if (ok) {
                    ce.hasShape = true;
                    ce.shape = g.shape;
                    ce.origins = g.origins;
                    b.out.shape = g.shape;
                    b.out.origins = g.origins;
                    b.out.key = key;
                    b.out.lastStepId = d.id;
                    b.hasShape = true;
                }
                cache_[d.id] = ce;
            }
            if (st.status == "error") b.failedStep = d.id;
        }
        st.ms = st.cached ? msSince(t0) : st.ms;
        if (st.status == "error" || st.status == "skipped") anyError = true;
        if (st.status == "warning") anyWarning = true;
        res.steps.push_back(st);
        if (stepDone) stepDone(i, st);
    }
    // Drop cache entries of steps that are no longer in the recipe.
    for (auto it = cache_.begin(); it != cache_.end();) {
        bool used = false;
        for (const auto& s : recipe.steps) used = used || s.id == it->first;
        it = used ? std::next(it) : cache_.erase(it);
    }
    for (const auto& id : bodyOrder)
        if (bodies[id].hasShape) res.bodies.push_back(bodies[id].out);
    res.outcome = anyError ? "error" : anyWarning ? "warning" : "ok";
    return res;
}

} // namespace pc
