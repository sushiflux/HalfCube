#include "parts.hpp"
#include "kt_util.hpp"

#include <BRepAdaptor_CompCurve.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepLib.hxx>
#include <BRepOffsetAPI_MakePipe.hxx>
#include <BRepOffsetAPI_MakePipeShell.hxx>
#include <BRepOffsetAPI_MakeThickSolid.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepTools_History.hxx>
#include <BRep_Tool.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <ChFiDS_ErrorStatus.hxx>
#include <GC_MakeArcOfCircle.hxx>
#include <Geom2d_Line.hxx>
#include <HelixBRep_BuilderHelix.hxx>
#include <Geom_CylindricalSurface.hxx>
#include <Law_Composite.hxx>
#include <Law_Linear.hxx>
#include <NCollection_Array1.hxx>
#include <NCollection_IndexedMap.hxx>
#include <NCollection_List.hxx>
#include <Precision.hxx>
#include <Standard_ErrorHandler.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Vertex.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Ax2.hxx>
#include <gp_Ax3.hxx>
#include <gp_Circ.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt2d.hxx>

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace kt {

namespace {

constexpr double kPi = 3.14159265358979323846;
using ShapeList = NCollection_List<TopoDS_Shape>;
using ShapeMap = NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>;

const gp_Dir kX(1, 0, 0), kY(0, 1, 0), kZ(0, 0, 1);
bool gRunVariants = true;

TopoDS_Shape makeBox(double x0, double y0, double z0, double x1, double y1, double z1) {
    return BRepPrimAPI_MakeBox(gp_Pnt(x0, y0, z0), gp_Pnt(x1, y1, z1)).Shape();
}

// Vertical cylinder used as the hole tool; it overshoots the block by 1 mm on both ends so the cut is
// unambiguous. The X direction of the axis puts the cylinder seam at angle 0 (+X from the axis).
TopoDS_Shape makeHoleTool(double cx, double cy, double r, double z0, double z1) {
    gp_Ax2 ax(gp_Pnt(cx, cy, z0 - 1.0), kZ, kX);
    return BRepPrimAPI_MakeCylinder(ax, r, (z1 - z0) + 2.0).Shape();
}

// Circular edge of radius r around (cx, cy) lying in the plane z.
TopoDS_Edge findCircleEdge(const TopoDS_Shape& s, double cx, double cy, double r, double z) {
    for (TopExp_Explorer ex(s, TopAbs_EDGE); ex.More(); ex.Next()) {
        const TopoDS_Edge& e = TopoDS::Edge(ex.Current());
        BRepAdaptor_Curve c(e);
        if (c.GetType() != GeomAbs_Circle) continue;
        const gp_Circ ci = c.Circle();
        if (std::abs(ci.Radius() - r) > 1e-6) continue;
        const gp_Pnt l = ci.Location();
        if (std::abs(l.X() - cx) > 1e-6 || std::abs(l.Y() - cy) > 1e-6 || std::abs(l.Z() - z) > 1e-6) continue;
        return e;
    }
    throw std::runtime_error("circular edge not found");
}

// Planar face whose outward normal is n and which lies at signed distance d along n.
TopoDS_Face findPlanarFace(const TopoDS_Shape& s, const gp_Dir& n, double d) {
    for (TopExp_Explorer ex(s, TopAbs_FACE); ex.More(); ex.Next()) {
        const TopoDS_Face& f = TopoDS::Face(ex.Current());
        BRepAdaptor_Surface sa(f, false);
        if (sa.GetType() != GeomAbs_Plane) continue;
        gp_Pln pl = sa.Plane();
        gp_Dir fn = pl.Axis().Direction();
        if (f.Orientation() == TopAbs_REVERSED) fn.Reverse();
        if (!fn.IsEqual(n, 1e-9)) continue;
        if (std::abs(gp_Vec(pl.Location().XYZ()).Dot(gp_Vec(n)) - d) > 1e-6) continue;
        return f;
    }
    throw std::runtime_error("planar face not found");
}

const char* stripeStatusName(ChFiDS_ErrorStatus st) {
    switch (st) {
    case ChFiDS_Ok: return "Ok";
    case ChFiDS_Error: return "Error";
    case ChFiDS_WalkingFailure: return "WalkingFailure";
    case ChFiDS_StartsolFailure: return "StartsolFailure";
    case ChFiDS_TwistedSurface: return "TwistedSurface";
    default: return "?";
    }
}

// Runs a fillet build and records the builder's own diagnostics.
CaseOut runFillet(BRepFilletAPI_MakeFillet& mk) {
    CaseOut out;
    try {
        OCC_CATCH_SIGNALS
        mk.Build();
    } catch (...) {
        out.error = describeCurrentException();
        out.info["exception_in_build"] = true;
        return out;
    }
    out.info["is_done"] = mk.IsDone();
    out.info["nb_contours"] = mk.NbContours();
    out.info["nb_faulty_contours"] = mk.NbFaultyContours();
    out.info["nb_faulty_vertices"] = mk.NbFaultyVertices();
    out.info["has_partial_result"] = mk.HasResult();
    Json st = Json::array();
    for (int ic = 1; ic <= mk.NbContours(); ++ic) st.push(stripeStatusName(mk.StripeStatus(ic)));
    out.info["stripe_status"] = st;
    if (!mk.IsDone()) {
        out.error = "BRepFilletAPI_MakeFillet: IsDone() == false";
        return out;
    }
    out.shape = mk.Shape();
    out.done = true;
    return out;
}

// Base block of P1 with its through hole.
TopoDS_Shape blockWithHole(double hx, double hy) {
    return BRepAlgoAPI_Cut(makeBox(0, 0, 0, 80, 50, 20), makeHoleTool(hx, hy, 10, 0, 20)).Shape();
}

// Radial distance from the hole axis to the inner boundary of the top face (z = 20), sampled at the given
// angles (degrees, measured from +X). This is where the fillet meets the top face: hole radius + fillet radius.
Json topBoundaryRadius(const TopoDS_Shape& s, double cx, double cy, double z, double rMax) {
    std::vector<std::pair<double, double>> samples;  // (angle rad, radius)
    double rmin = 1e300, rmax = -1e300;  // over curved edges only (the fillet boundary)
    for (TopExp_Explorer ex(s, TopAbs_EDGE); ex.More(); ex.Next()) {
        const TopoDS_Edge& e = TopoDS::Edge(ex.Current());
        if (BRep_Tool::Degenerated(e)) continue;
        BRepAdaptor_Curve c(e);
        const double u0 = c.FirstParameter(), u1 = c.LastParameter();
        bool inPlane = true;
        for (int k = 0; k <= 8 && inPlane; ++k) {
            const gp_Pnt p = c.Value(u0 + (u1 - u0) * k / 8.0);
            if (std::abs(p.Z() - z) > 1e-5 || std::hypot(p.X() - cx, p.Y() - cy) > rMax) inPlane = false;
        }
        if (!inPlane) continue;
        const bool curved = c.GetType() != GeomAbs_Line;
        for (int k = 0; k <= 4000; ++k) {
            const gp_Pnt p = c.Value(u0 + (u1 - u0) * k / 4000.0);
            const double r = std::hypot(p.X() - cx, p.Y() - cy);
            samples.emplace_back(std::atan2(p.Y() - cy, p.X() - cx), r);
            if (curved) { rmin = std::min(rmin, r); rmax = std::max(rmax, r); }
        }
    }
    Json j = Json::object();
    if (samples.empty()) { j["error"] = "no boundary edges found in the top plane"; return j; }
    for (double deg : {0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0}) {
        const double a = deg * kPi / 180.0;
        // Nearest boundary point in that direction: smallest radius among samples within 0.5 degrees.
        double r = 1e300;
        for (auto& s2 : samples)
            if (std::abs(std::remainder(s2.first - a, 2 * kPi)) <= 0.5 * kPi / 180.0) r = std::min(r, s2.second);
        j["r_at_" + std::to_string((int)deg) + "deg"] = r;
    }
    j["r_min_curved_edges"] = rmin;
    j["r_max_curved_edges"] = rmax;
    return j;
}

// ---------------------------------------------------------------- P1

CaseOut p1Constant(double hx, double hy, double radius) {
    TopoDS_Shape base = blockWithHole(hx, hy);
    const TopoDS_Edge e = findCircleEdge(base, hx, hy, 10, 20);
    BRepFilletAPI_MakeFillet mk(base);
    mk.Add(radius, e);
    const auto t0 = Clock::now();
    CaseOut out = runFillet(mk);
    out.opMs = msSince(t0);
    if (out.done) out.info["fillet_boundary_on_top_face"] = topBoundaryRadius(out.shape, hx, hy, 20, 30);
    return out;
}

// Tent function of P1b: radius 2 at the start point, 5 halfway round, back to 2; u in [0, 1).
double tent(double u) {
    u = u - std::floor(u);
    return u <= 0.5 ? 2.0 + 6.0 * u : 2.0 + 6.0 * (1.0 - u);
}

// Relative position (0..1) of the point (50, 25, 20) on the closed hole edge, measured from its vertex.
double relativeStart(const TopoDS_Edge& e) {
    BRepAdaptor_Curve c(e);
    const gp_Circ ci = c.Circle();
    TopoDS_Vertex v1, v2;
    TopExp::Vertices(e, v1, v2);
    const gp_Pnt pv = BRep_Tool::Pnt(v1);
    const double a = std::atan2(pv.Y() - ci.Location().Y(), pv.X() - ci.Location().X());
    // The target point lies at angle 0 around the axis.
    double rel = -a / (2 * kPi);
    rel -= std::floor(rel);
    return rel;
}

CaseOut p1Variable(const std::string& mode) {
    TopoDS_Shape base = blockWithHole(40, 25);
    const TopoDS_Edge e = findCircleEdge(base, 40, 25, 10, 20);
    const double u0 = relativeStart(e);
    BRepFilletAPI_MakeFillet mk(base);
    Json law = Json::array();
    if (mode == "law_function") {
        // Piecewise linear law handed over as a Law_Function (two Law_Linear pieces).
        const double len = 2 * kPi * 10;
        occ::handle<Law_Composite> comp = new Law_Composite(0, len, 1e-9);
        occ::handle<Law_Linear> l1 = new Law_Linear();
        l1->Set(0, 2, len / 2, 5);
        occ::handle<Law_Linear> l2 = new Law_Linear();
        l2->Set(len / 2, 5, len, 2);
        comp->ChangeLaws().Append(l1);
        comp->ChangeLaws().Append(l2);
        mk.Add(comp, e);
    } else {
        const int n = mode == "interp3" ? 2 : 16;  // number of intervals
        std::vector<double> us;
        for (int k = 0; k < n; ++k) {
            double u = u0 + double(k) / n;
            us.push_back(u - std::floor(u));
        }
        us.push_back(0.0);
        us.push_back(1.0);
        std::sort(us.begin(), us.end());
        us.erase(std::unique(us.begin(), us.end(), [](double a, double b) { return std::abs(a - b) < 1e-12; }), us.end());
        NCollection_Array1<gp_Pnt2d> uandr(1, (int)us.size());
        for (int i = 0; i < (int)us.size(); ++i) {
            const double r = tent(us[i] - u0);
            uandr(i + 1) = gp_Pnt2d(us[i], r);
            Json p = Json::array(); p.push(us[i]); p.push(r); law.push(p);
        }
        mk.Add(uandr, e);
    }
    const auto t0 = Clock::now();
    CaseOut out = runFillet(mk);
    out.opMs = msSince(t0);
    out.info["mode"] = mode;
    out.info["start_point_relative_parameter"] = u0;
    if (!law.empty()) out.info["u_and_r"] = law;
    if (out.done) {
        out.info["is_constant"] = mk.IsConstant(1);
        out.info["fillet_boundary_on_top_face"] = topBoundaryRadius(out.shape, 40, 25, 20, 30);
    }
    return out;
}

CaseOut p1c() {
    TopoDS_Shape b = makeBox(0, 0, 0, 40, 40, 40);
    BRepFilletAPI_MakeFillet mk(b);
    for (TopExp_Explorer ex(b, TopAbs_EDGE); ex.More(); ex.Next()) mk.Add(5.0, TopoDS::Edge(ex.Current()));
    const auto t0 = Clock::now();
    CaseOut out = runFillet(mk);
    out.opMs = msSince(t0);
    return out;
}

// ---------------------------------------------------------------- P2

struct ShellVariant {
    const char* name;
    bool intersection;
    bool selfInter;
    GeomAbs_JoinType join;
    bool removeIntEdges;
};
// The first entry is the OCCT default of MakeThickSolidByJoin; the others are its documented switches.
const ShellVariant kShellVariants[] = {
    {"join_arc", false, false, GeomAbs_Arc, false},
    {"join_intersection", false, false, GeomAbs_Intersection, false},
    {"intersection_true", true, false, GeomAbs_Arc, false},
    {"self_inter_true", false, true, GeomAbs_Arc, false},
    {"remove_int_edges_true", false, false, GeomAbs_Arc, true},
};

const char* offsetErrorName(BRepOffset_Error e) {
    switch (e) {
    case BRepOffset_NoError: return "NoError";
    case BRepOffset_UnknownError: return "UnknownError";
    case BRepOffset_BadNormalsOnGeometry: return "BadNormalsOnGeometry";
    case BRepOffset_C0Geometry: return "C0Geometry";
    case BRepOffset_NullOffset: return "NullOffset";
    case BRepOffset_NotConnectedShell: return "NotConnectedShell";
    case BRepOffset_CannotTrimEdges: return "CannotTrimEdges";
    case BRepOffset_CannotFuseVertices: return "CannotFuseVertices";
    case BRepOffset_CannotExtentEdge: return "CannotExtentEdge";
    case BRepOffset_UserBreak: return "UserBreak";
    case BRepOffset_MixedConnectivity: return "MixedConnectivity";
    default: return "?";
    }
}

CaseOut shell(const TopoDS_Shape& solid, double topZ, const ShellVariant& v) {
    CaseOut out;
    ShapeList closing;
    closing.Append(findPlanarFace(solid, kZ, topZ));
    BRepOffsetAPI_MakeThickSolid mk;
    const auto t0 = Clock::now();
    try {
        OCC_CATCH_SIGNALS
        mk.MakeThickSolidByJoin(solid, closing, -2.0, 1e-3, BRepOffset_Skin, v.intersection, v.selfInter, v.join, v.removeIntEdges);
    } catch (...) {
        out.error = describeCurrentException();
        return out;
    }
    out.opMs = msSince(t0);
    out.info["variant"] = v.name;
    out.info["is_done"] = mk.IsDone();
    out.info["offset_error"] = offsetErrorName(mk.MakeOffset().Error());
    if (!mk.IsDone()) {
        out.error = std::string("BRepOffsetAPI_MakeThickSolid: IsDone() == false, Error() = ") +
                    offsetErrorName(mk.MakeOffset().Error());
        return out;
    }
    out.shape = mk.Shape();
    out.done = true;
    return out;
}

TopoDS_Shape p2bBase() {
    TopoDS_Shape b = makeBox(0, 0, 0, 50, 50, 30);
    BRepFilletAPI_MakeFillet mk(b);
    for (TopExp_Explorer ex(b, TopAbs_EDGE); ex.More(); ex.Next()) {
        const TopoDS_Edge& e = TopoDS::Edge(ex.Current());
        TopoDS_Vertex v1, v2;
        TopExp::Vertices(e, v1, v2);
        if (std::abs(BRep_Tool::Pnt(v1).Z() - 30) < 1e-9 && std::abs(BRep_Tool::Pnt(v2).Z() - 30) < 1e-9)
            mk.Add(5.0, e);
    }
    mk.Build();
    if (!mk.IsDone()) throw std::runtime_error("P2b: fillet of the four top edges failed");
    return mk.Shape();
}

TopoDS_Shape p2cBase() {
    return BRepAlgoAPI_Cut(makeBox(0, 0, 0, 60, 40, 30), makeHoleTool(30, 20, 5, 0, 30)).Shape();
}

// ---------------------------------------------------------------- P3

TopoDS_Wire circleWire(double z, double r, const std::vector<double>& splitDeg = {}) {
    gp_Circ c(gp_Ax2(gp_Pnt(0, 0, z), kZ, kX), r);
    if (splitDeg.empty()) return BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(c).Edge()).Wire();
    BRepBuilderAPI_MakeWire mw;
    for (size_t i = 0; i < splitDeg.size(); ++i) {
        const double a0 = splitDeg[i] * kPi / 180.0;
        double a1 = splitDeg[(i + 1) % splitDeg.size()] * kPi / 180.0;
        if (a1 <= a0) a1 += 2 * kPi;
        mw.Add(BRepBuilderAPI_MakeEdge(c, a0, a1).Edge());
    }
    return mw.Wire();
}

TopoDS_Wire rectWire(double z, double hx, double hy) {
    // Counter-clockwise about +Z, starting at the corner in the fourth quadrant.
    BRepBuilderAPI_MakePolygon p(gp_Pnt(hx, -hy, z), gp_Pnt(hx, hy, z), gp_Pnt(-hx, hy, z), gp_Pnt(-hx, -hy, z), true);
    return p.Wire();
}

CaseOut loft(const std::vector<TopoDS_Wire>& wires, const char* mapping) {
    CaseOut out;
    BRepOffsetAPI_ThruSections mk(/*isSolid*/ true, /*ruled*/ false, 1e-6);
    for (const auto& w : wires) mk.AddWire(w);
    mk.CheckCompatibility(true);
    const auto t0 = Clock::now();
    try {
        OCC_CATCH_SIGNALS
        mk.Build();
    } catch (...) {
        out.error = describeCurrentException();
        return out;
    }
    out.opMs = msSince(t0);
    out.info["vertex_mapping"] = mapping;
    out.info["is_done"] = mk.IsDone();
    if (!mk.IsDone()) { out.error = "BRepOffsetAPI_ThruSections: IsDone() == false"; return out; }
    out.shape = mk.Shape();
    out.done = true;
    return out;
}

double deg(double rad) { return rad * 180.0 / kPi; }

// P2b: every horizontal cross-section of the filleted box and of its cavity is a square, so the volume of the
// shell is the integral of (outer side^2 - cavity side^2) over z (Simpson rule, 20000 steps per interval).
double p2bExpectedVolume() {
    auto outerInset = [](double z) { return z <= 25 ? 0.0 : 5.0 - std::sqrt(std::max(0.0, 25.0 - (z - 25) * (z - 25))); };
    auto cavityInset = [](double z) {
        if (z <= 25) return 2.0;
        if (z <= 28) return 2.0 + 3.0 - std::sqrt(std::max(0.0, 9.0 - (z - 25) * (z - 25)));
        return 5.0;  // above the inner fillet the cavity is bounded by the rim of the removed top face
    };
    auto area = [&](double z) {
        const double o = 50 - 2 * outerInset(z);
        const double c = z < 2 ? 0.0 : 50 - 2 * cavityInset(z);
        return o * o - c * c;
    };
    const int n = 20000;
    double sum = 0;
    for (int seg = 0; seg < 2; ++seg) {  // split at z = 2 where the integrand jumps
        const double a = seg == 0 ? 0.0 : 2.0, b = seg == 0 ? 2.0 - 1e-12 : 30.0;
        const double h = (b - a) / n;
        double acc = area(a) + area(b);
        for (int i = 1; i < n; ++i) acc += area(a + i * h) * (i % 2 ? 4 : 2);
        sum += acc * h / 3;
    }
    return sum;
}

// ---------------------------------------------------------------- P4

const char* pipeErrorName(BRepBuilderAPI_PipeError e) {
    switch (e) {
    case BRepBuilderAPI_PipeDone: return "PipeDone";
    case BRepBuilderAPI_PipeNotDone: return "PipeNotDone";
    case BRepBuilderAPI_PlaneNotIntersectGuide: return "PlaneNotIntersectGuide";
    case BRepBuilderAPI_ImpossibleContact: return "ImpossibleContact";
    default: return "?";
    }
}

TopoDS_Wire p4aPath() {
    const TopoDS_Edge l1 = BRepBuilderAPI_MakeEdge(gp_Pnt(0, 0, 0), gp_Pnt(50, 0, 0)).Edge();
    gp_Circ c(gp_Ax2(gp_Pnt(50, 20, 0), kZ, kX), 20);
    // Counter-clockwise from (50, 0) to (70, 20): tangent to the first line, turning towards +Y.
    const TopoDS_Edge arc = BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(c, gp_Pnt(50, 0, 0), gp_Pnt(70, 20, 0), true).Value()).Edge();
    const TopoDS_Edge l2 = BRepBuilderAPI_MakeEdge(gp_Pnt(70, 20, 0), gp_Pnt(70, 60, 0)).Edge();
    return BRepBuilderAPI_MakeWire(l1, arc, l2).Wire();
}

struct HelixData {
    TopoDS_Wire spine;
    TopoDS_Face support;
    TopoDS_Wire profile;
};

HelixData p4bGeometry() {
    const double r = 15, pitch = 10, turns = 5;
    occ::handle<Geom_CylindricalSurface> cyl = new Geom_CylindricalSurface(gp_Ax3(gp_Pnt(0, 0, 0), kZ, kX), r);
    // On the cylinder, u is the angle and v the height: one turn is (2*pi, pitch) in (u, v).
    gp_Dir2d d(2 * kPi, pitch);
    occ::handle<Geom2d_Line> line = new Geom2d_Line(gp_Pnt2d(0, 0), d);
    const double len2d = turns * std::hypot(2 * kPi, pitch);
    TopoDS_Edge e = BRepBuilderAPI_MakeEdge(line, cyl, 0.0, len2d).Edge();
    BRepLib::BuildCurves3d(e, 1e-7, GeomAbs_C2, 14, 200);
    HelixData h;
    h.spine = BRepBuilderAPI_MakeWire(e).Wire();
    h.support = BRepBuilderAPI_MakeFace(cyl, 0.0, 2 * kPi * turns, -1.0, pitch * turns + 1.0, 1e-7).Face();
    // Profile: circle of diameter 4 at the start point, perpendicular to the helix tangent there.
    const gp_Vec tangent(0.0, r, pitch / (2 * kPi));
    gp_Circ c(gp_Ax2(gp_Pnt(r, 0, 0), gp_Dir(tangent)), 2.0);
    h.profile = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(c).Edge()).Wire();
    return h;
}

// Alternative spine from the TKHelix toolkit (HelixBRep_BuilderHelix), new in OCCT 8.
bool tkHelix(TopoDS_Wire& spine, TopoDS_Wire& profile, Json& info) {
    HelixBRep_BuilderHelix b;
    NCollection_Array1<double> pitches(1, 1), turns(1, 1);
    pitches(1) = 10.0;
    turns(1) = 5.0;
    b.SetParameters(gp_Ax3(gp_Pnt(0, 0, 0), kZ, kX), 30.0, pitches, turns);
    b.SetApproxParameters(1e-6, 8, GeomAbs_C2);
    b.Perform();
    info["error_status"] = b.ErrorStatus();
    info["warning_status"] = b.WarningStatus();
    info["tolerance_reached"] = b.ToleranceReached();
    if (b.ErrorStatus() != 0 || b.Shape().IsNull()) return false;
    const TopoDS_Shape sh = b.Shape();
    if (sh.ShapeType() == TopAbs_WIRE) spine = TopoDS::Wire(sh);
    else if (sh.ShapeType() == TopAbs_EDGE) spine = BRepBuilderAPI_MakeWire(TopoDS::Edge(sh)).Wire();
    else return false;
    BRepAdaptor_CompCurve cc(spine);
    gp_Pnt p0;
    gp_Vec t0;
    cc.D1(cc.FirstParameter(), p0, t0);
    Json sp = Json::array(); sp.push(p0.X()); sp.push(p0.Y()); sp.push(p0.Z());
    info["start_point"] = sp;
    const gp_Pnt p1 = cc.Value(cc.LastParameter());
    Json ep = Json::array(); ep.push(p1.X()); ep.push(p1.Y()); ep.push(p1.Z());
    info["end_point"] = ep;
    int nEdges = 0;
    for (TopExp_Explorer ex(spine, TopAbs_EDGE); ex.More(); ex.Next()) ++nEdges;
    info["edges"] = nEdges;
    gp_Circ c(gp_Ax2(p0, gp_Dir(t0)), 2.0);
    profile = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(c).Edge()).Wire();
    return true;
}

CaseOut pipeShell(const TopoDS_Wire& spine, const TopoDS_Wire& profile, const std::string& mode,
                  const TopoDS_Face* support = nullptr) {
    CaseOut out;
    BRepOffsetAPI_MakePipeShell mk(spine);
    if (mode == "corrected_frenet") mk.SetMode(false);
    else if (mode == "frenet") mk.SetMode(true);
    else if (mode == "binormal_z") mk.SetMode(gp_Dir(0, 0, 1));
    else if (mode == "spine_support") {
        if (!support || !mk.SetMode(*support)) { out.error = "SetMode(SpineSupport) returned false"; return out; }
    }
    mk.Add(profile, /*WithContact*/ false, /*WithCorrection*/ false);
    const auto t0 = Clock::now();
    try {
        OCC_CATCH_SIGNALS
        mk.Build();
    } catch (...) {
        out.error = describeCurrentException();
        return out;
    }
    out.info["mode"] = mode;
    out.info["status"] = pipeErrorName(mk.GetStatus());
    if (!mk.IsDone()) { out.error = std::string("BRepOffsetAPI_MakePipeShell: IsDone() == false, status ") + pipeErrorName(mk.GetStatus()); return out; }
    const bool solid = mk.MakeSolid();
    out.opMs = msSince(t0);
    out.info["make_solid"] = solid;
    out.info["error_on_surface_mm"] = mk.ErrorOnSurface();
    if (!solid) { out.error = "MakeSolid() returned false"; return out; }
    out.shape = mk.Shape();
    out.done = true;
    return out;
}

CaseOut withVariants(const std::vector<std::pair<std::string, std::function<CaseOut()>>>& variants) {
    // The first variant is the primary result; the others are recorded for comparison.
    CaseOut primary;
    Json others = Json::object();
    for (size_t i = 0; i < variants.size(); ++i) {
        CaseOut o;
        try { OCC_CATCH_SIGNALS o = variants[i].second(); } catch (...) { o.error = describeCurrentException(); }
        if (i == 0) { primary = o; if (!gRunVariants) break; continue; }
        Json v = o.info;
        v["op_ms_single_run"] = o.opMs;
        v["done"] = o.done;
        if (!o.error.empty()) v["error"] = o.error;
        if (o.done) v["measure"] = measure(o.shape);
        others[variants[i].first] = v;
    }
    primary.info["primary_variant"] = variants[0].first;
    if (gRunVariants && !others.empty()) primary.info["other_variants"] = others;
    return primary;
}

} // namespace

void setRunVariants(bool on) { gRunVariants = on; }

std::vector<CaseDef> allCases() {
    std::vector<CaseDef> c;
    c.push_back({"P1a", "Block 80x50x20, hole D20 at (40,25), constant fillet r=3 on top hole edge",
                 [] { return p1Constant(40, 25, 3); }});
    c.push_back({"P1b", "Same block, variable fillet 2 -> 5 -> 2 on top hole edge",
                 [] {
                     return withVariants({
                         {"linear17", [] { return p1Variable("linear17"); }},
                         {"interp3", [] { return p1Variable("interp3"); }},
                         {"law_function", [] { return p1Variable("law_function"); }},
                     });
                 }});
    c.push_back({"P1c", "Box 40^3, constant fillet r=5 on all 12 edges", [] { return p1c(); }});
    c.push_back({"P1d_r3", "Hole D20 at (14,25) (wall 4), fillet r=3", [] { return p1Constant(14, 25, 3); }});
    c.push_back({"P1d_r5", "Hole D20 at (14,25) (wall 4), fillet r=5 (breaks through x=0)",
                 [] { return p1Constant(14, 25, 5); }});
    for (const char* id : {"P2a", "P2b", "P2c"}) {
        const std::string sid = id;
        const double topZ = 30;
        std::function<TopoDS_Shape()> base;
        double expected = 0;
        if (sid == "P2a") { base = [] { return makeBox(0, 0, 0, 60, 40, 30); }; expected = 60.0 * 40 * 30 - 56.0 * 36 * 28; }
        if (sid == "P2b") { base = p2bBase; expected = p2bExpectedVolume(); }
        if (sid == "P2c") {
            base = p2cBase;
            expected = (60.0 * 40 * 30 - kPi * 25 * 30) - (56.0 * 36 * 28 - kPi * 49 * 28);
        }
        std::string desc = sid == "P2a" ? "Box 60x40x30, remove top, wall 2 inward"
                         : sid == "P2b" ? "Box 50x50x30 with top edges filleted r=5, remove top, wall 2 inward"
                                        : "Box 60x40x30 with hole D10 at (30,20), remove top, wall 2 inward";
        c.push_back({sid, desc, [base, topZ] {
                         const TopoDS_Shape s = base();
                         std::vector<std::pair<std::string, std::function<CaseOut()>>> v;
                         for (const auto& sv : kShellVariants) v.emplace_back(sv.name, [s, topZ, sv] { return shell(s, topZ, sv); });
                         // Same default settings, but on the bare SOLID instead of the COMPOUND the fillet or cut returns.
                         v.emplace_back("join_arc_on_extracted_solid", [s, topZ] {
                             TopoDS_Shape solid = s;
                             for (TopExp_Explorer ex(s, TopAbs_SOLID); ex.More(); ex.Next()) { solid = ex.Current(); break; }
                             CaseOut o = shell(solid, topZ, kShellVariants[0]);
                             o.info["input_type"] = solid.ShapeType() == TopAbs_SOLID ? "SOLID" : "other";
                             return o;
                         });
                         CaseOut o = withVariants(v);
                         o.info["base_solid"] = measure(s);
                         return o;
                     }, expected});
    }
    c.push_back({"P3a", "Smooth solid loft: circle D40 z=0, square 30 z=40, circle D20 z=80", [] {
                     return withVariants({
                         {"automatic", [] { return loft({circleWire(0, 20), rectWire(40, 15, 15), circleWire(80, 10)}, "none (CheckCompatibility)"); }},
                         {"manual_split_circles", [] {
                              const std::vector<double> s = {-45, 45, 135, 225};
                              return loft({circleWire(0, 20, s), rectWire(40, 15, 15), circleWire(80, 10, s)}, "circles split at the square's corner angles");
                          }},
                     });
                 }});
    c.push_back({"P3b", "Smooth solid loft: rectangle 40x20 z=0, circle D30 z=50", [] {
                     return withVariants({
                         {"automatic", [] { return loft({rectWire(0, 20, 10), circleWire(50, 15)}, "none (CheckCompatibility)"); }},
                         {"manual_split_circle", [] {
                              const double a = deg(std::atan2(10.0, 20.0));
                              return loft({rectWire(0, 20, 10), circleWire(50, 15, {-a, a, 180 - a, 180 + a})}, "circle split at the rectangle's corner angles");
                          }},
                     });
                 }});
    c.push_back({"P4a", "Pipe D8 along line-arc-line", [] {
                     const TopoDS_Wire path = p4aPath();
                     const TopoDS_Wire prof = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(gp_Circ(gp_Ax2(gp_Pnt(0, 0, 0), kX), 4.0)).Edge()).Wire();
                     return withVariants({
                         {"pipeshell_corrected_frenet", [=] { return pipeShell(path, prof, "corrected_frenet"); }},
                         {"pipeshell_frenet", [=] { return pipeShell(path, prof, "frenet"); }},
                         {"makepipe", [=] {
                              CaseOut o;
                              const auto t0 = Clock::now();
                              BRepOffsetAPI_MakePipe mp(path, BRepBuilderAPI_MakeFace(prof).Face());
                              mp.Build();
                              o.opMs = msSince(t0);
                              if (!mp.IsDone()) { o.error = "BRepOffsetAPI_MakePipe: IsDone() == false"; return o; }
                              o.shape = mp.Shape(); o.done = true; return o;
                          }},
                     });
                 }, 16 * kPi * (90 + 10 * kPi)});
    {
        const double helixLen = 5 * std::hypot(2 * kPi * 15, 10.0);
        c.push_back({"P4b", "Spring: circle D4 along helix r=15 pitch 10, 5 turns", [] {
                         const HelixData h = p4bGeometry();
                         return withVariants({
                             {"frenet", [h] { return pipeShell(h.spine, h.profile, "frenet"); }},
                             {"corrected_frenet", [h] { return pipeShell(h.spine, h.profile, "corrected_frenet"); }},
                             {"binormal_z", [h] { return pipeShell(h.spine, h.profile, "binormal_z"); }},
                             {"spine_support", [h] { return pipeShell(h.spine, h.profile, "spine_support", &h.support); }},
                             {"tkhelix_spine_frenet", [] {
                                  Json hinfo = Json::object();
                                  TopoDS_Wire spine, profile;
                                  if (!tkHelix(spine, profile, hinfo)) { CaseOut o; o.error = "HelixBRep_BuilderHelix failed"; o.info = hinfo; return o; }
                                  CaseOut o = pipeShell(spine, profile, "frenet");
                                  o.info["helix_builder"] = hinfo;
                                  return o;
                              }},
                         });
                     }, 4 * kPi * helixLen});
    }
    return c;
}

// ---------------------------------------------------------------- E1

namespace {

std::string faceLabel(const ShapeMap& m, const TopoDS_Shape& f, const char* prefix) {
    const int i = m.FindIndex(f);
    return std::string(prefix) + (i ? std::to_string(i) : std::string("?")) + " " + describeFace(TopoDS::Face(f));
}

template <class Algo>
Json faceHistory(Algo& algo, const TopoDS_Shape& input, const char* inPrefix, const ShapeMap& outFaces,
                 const char* outPrefix) {
    Json arr = Json::array();
    ShapeMap inFaces;
    TopExp::MapShapes(input, TopAbs_FACE, inFaces);
    for (int i = 1; i <= inFaces.Extent(); ++i) {
        const TopoDS_Shape& f = inFaces(i);
        Json e = Json::object();
        e["input"] = faceLabel(inFaces, f, inPrefix);
        Json mod = Json::array(), gen = Json::array();
        for (const auto& s : algo.Modified(f)) if (s.ShapeType() == TopAbs_FACE) mod.push(faceLabel(outFaces, s, outPrefix));
        for (const auto& s : algo.Generated(f)) if (s.ShapeType() == TopAbs_FACE) gen.push(faceLabel(outFaces, s, outPrefix));
        const bool del = algo.IsDeleted(f);
        // BRepTools_History promises that a shape is never removed and modified at once; report it if it is.
        std::string status = del && !mod.empty() ? "INCONSISTENT: removed flag set and modified"
                           : del ? "deleted" : !mod.empty() ? "modified" : outFaces.Contains(f) ? "unchanged" : "absent, no history";
        e["status"] = status;
        if (!mod.empty()) e["modified_into"] = mod;
        if (!gen.empty()) e["generated"] = gen;
        arr.push(e);
    }
    return arr;
}

} // namespace

Json historyP1a() {
    Json j = Json::object();
    const TopoDS_Shape box = makeBox(0, 0, 0, 80, 50, 20);
    const TopoDS_Shape tool = makeHoleTool(40, 25, 10, 0, 20);
    BRepAlgoAPI_Cut cut(box, tool);
    if (!cut.IsDone()) { j["error"] = "cut failed"; return j; }
    const TopoDS_Shape cutRes = cut.Shape();
    ShapeMap cutFaces;
    TopExp::MapShapes(cutRes, TopAbs_FACE, cutFaces);
    Json c = Json::object();
    c["api"] = "BRepAlgoAPI_Cut::Modified/Generated/IsDeleted (same data as BRepAlgoAPI_Cut::History())";
    c["result_faces"] = cutFaces.Extent();
    c["box_faces"] = faceHistory(cut, box, "B", cutFaces, "C");
    c["tool_faces"] = faceHistory(cut, tool, "T", cutFaces, "C");
    j["hole_cut"] = c;

    const TopoDS_Edge e = findCircleEdge(cutRes, 40, 25, 10, 20);
    BRepFilletAPI_MakeFillet fil(cutRes);
    fil.Add(3.0, e);
    fil.Build();
    if (!fil.IsDone()) { j["error"] = "fillet failed"; return j; }
    const TopoDS_Shape res = fil.Shape();
    ShapeMap resFaces;
    TopExp::MapShapes(res, TopAbs_FACE, resFaces);
    Json f = Json::object();
    f["api"] = "BRepFilletAPI_MakeFillet::Modified/Generated/IsDeleted, NewFaces";
    f["result_faces"] = resFaces.Extent();
    f["input_faces"] = faceHistory(fil, cutRes, "C", resFaces, "F");
    Json edgeGen = Json::array();
    for (const auto& s : fil.Generated(e)) edgeGen.push(faceLabel(resFaces, s, "F"));
    f["generated_from_filleted_edge"] = edgeGen;
    Json newFaces = Json::array();
    for (int i = 1; i <= fil.NbSurfaces(); ++i)
        for (const auto& s : fil.NewFaces(i)) newFaces.push(faceLabel(resFaces, s, "F"));
    f["new_faces"] = newFaces;
    Json all = Json::array();
    for (int i = 1; i <= resFaces.Extent(); ++i) all.push(faceLabel(resFaces, resFaces(i), "F"));
    f["all_result_faces"] = all;
    j["fillet"] = f;

    // Merged history (box and tool faces -> final faces) with BRepTools_History.
    ShapeList cutArgs;
    cutArgs.Append(box);
    cutArgs.Append(tool);
    occ::handle<BRepTools_History> h1 = cut.History();
    ShapeList filArgs;
    filArgs.Append(cutRes);
    occ::handle<BRepTools_History> h2 = new BRepTools_History(filArgs, fil);
    if (h1.IsNull()) { j["merged_error"] = "BRepAlgoAPI_Cut::History() returned null"; return j; }
    struct Wrap {
        occ::handle<BRepTools_History> h;
        const NCollection_List<TopoDS_Shape>& Modified(const TopoDS_Shape& s) { return h->Modified(s); }
        const NCollection_List<TopoDS_Shape>& Generated(const TopoDS_Shape& s) { return h->Generated(s); }
        bool IsDeleted(const TopoDS_Shape& s) { return h->IsRemoved(s); }
    };
    // The cut history object as returned by BRepAlgoAPI_Cut::History(), before merging.
    {
        Wrap w1{h1};
        Json hc = Json::object();
        hc["box_faces"] = faceHistory(w1, box, "B", cutFaces, "C");
        hc["tool_faces"] = faceHistory(w1, tool, "T", cutFaces, "C");
        j["hole_cut_via_BRepTools_History"] = hc;
    }
    // Merge into a copy of the cut history (BRepTools_History has no identity start when empty).
    occ::handle<BRepTools_History> merged = new BRepTools_History(*h1);
    merged->Merge(h2);
    Wrap w{merged};
    Json m = Json::object();
    m["api"] = "BRepAlgoAPI_Cut::History() merged (BRepTools_History::Merge) with a BRepTools_History built from the fillet";
    m["box_faces"] = faceHistory(w, box, "B", resFaces, "F");
    m["tool_faces"] = faceHistory(w, tool, "T", resFaces, "F");
    j["merged_box_and_tool_to_final"] = m;
    return j;
}

} // namespace kt
