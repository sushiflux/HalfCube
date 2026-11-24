#include "kt_util.hpp"

#include <BOPAlgo_ArgumentAnalyzer.hxx>
#include <BOPAlgo_CheckResult.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRepCheck.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_Result.hxx>
#include <BRepGProp.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <Poly_Triangulation.hxx>
#include <Standard_ErrorHandler.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS.hxx>
#include <NCollection_IndexedMap.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Pln.hxx>
#include <gp_Torus.hxx>
#include <gp_Cone.hxx>
#include <gp_Sphere.hxx>

#ifdef KT_WITH_STEP
#include <DESTEP_Parameters.hxx>
#include <STEPControl_Reader.hxx>
#include <STEPControl_Writer.hxx>
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <exception>
#include <sstream>
#include <stdexcept>
#include <unordered_map>

namespace kt {

using ShapeMap = NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>;

double median(std::vector<double> v) {
    if (v.empty()) return std::nan("");
    std::sort(v.begin(), v.end());
    const size_t n = v.size();
    return n % 2 ? v[n / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
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

static int count(const TopoDS_Shape& s, TopAbs_ShapeEnum t) {
    ShapeMap m;
    TopExp::MapShapes(s, t, m);
    return m.Extent();
}

static const char* shapeTypeName(TopAbs_ShapeEnum t) {
    switch (t) {
    case TopAbs_COMPOUND: return "COMPOUND";
    case TopAbs_COMPSOLID: return "COMPSOLID";
    case TopAbs_SOLID: return "SOLID";
    case TopAbs_SHELL: return "SHELL";
    case TopAbs_FACE: return "FACE";
    case TopAbs_WIRE: return "WIRE";
    case TopAbs_EDGE: return "EDGE";
    case TopAbs_VERTEX: return "VERTEX";
    default: return "SHAPE";
    }
}

bool isValid(const TopoDS_Shape& s, Json* details) {
    BRepCheck_Analyzer ana(s);
    const bool ok = ana.IsValid();
    if (!ok && details) {
        Json list = Json::array();
        int listed = 0;
        for (TopAbs_ShapeEnum t : {TopAbs_VERTEX, TopAbs_EDGE, TopAbs_WIRE, TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID}) {
            ShapeMap m;
            TopExp::MapShapes(s, t, m);
            for (int i = 1; i <= m.Extent() && listed < 20; ++i) {
                if (ana.IsValid(m(i))) continue;
                const auto& res = ana.Result(m(i));
                if (res.IsNull()) continue;
                std::ostringstream os;
                for (auto st : res->Status()) {
                    if (st == BRepCheck_NoError) continue;
                    BRepCheck::Print(st, os);
                }
                for (res->InitContextIterator(); res->MoreShapeInContext(); res->NextShapeInContext()) {
                    for (auto st : res->StatusOnShape()) {
                        if (st == BRepCheck_NoError) continue;
                        BRepCheck::Print(st, os);
                    }
                }
                std::string txt = os.str();
                std::replace(txt.begin(), txt.end(), '\n', ' ');
                if (txt.empty()) continue;
                list.push(std::string(shapeTypeName(t)) + " #" + std::to_string(i) + ": " + txt);
                ++listed;
            }
        }
        (*details)["brepcheck_faults"] = list;
    }
    return ok;
}

Json selfInterference(const TopoDS_Shape& s) {
    Json j = Json::object();
    BOPAlgo_ArgumentAnalyzer a;
    a.SetShape1(s);
    a.ArgumentTypeMode() = false;
    a.SelfInterMode() = true;
    a.SmallEdgeMode() = true;
    a.RebuildFaceMode() = false;
    a.TangentMode() = false;
    a.MergeVertexMode() = false;
    a.MergeEdgeMode() = false;
    a.ContinuityMode() = false;
    a.CurveOnSurfaceMode() = true;
    const auto t0 = Clock::now();
    try {
        OCC_CATCH_SIGNALS
        a.Perform();
    } catch (...) {
        j["error"] = describeCurrentException();
        return j;
    }
    j["ms"] = msSince(t0);
    j["has_faulty"] = a.HasFaulty();
    if (a.HasFaulty()) {
        static const char* names[] = {"Unknown", "BadType", "SelfIntersect", "TooSmallEdge", "NonRecoverableFace",
                                      "IncompatibilityOfVertex", "IncompatibilityOfEdge", "IncompatibilityOfFace",
                                      "OperationAborted", "GeomAbs_C0", "InvalidCurveOnSurface", "NotValid"};
        Json list = Json::array();
        for (const auto& r : a.GetCheckResult()) {
            const int st = static_cast<int>(r.GetCheckStatus());
            std::string txt = (st >= 0 && st < 12) ? names[st] : std::to_string(st);
            if (r.GetCheckStatus() == BOPAlgo_InvalidCurveOnSurface)
                txt += " maxdist=" + std::to_string(r.GetMaxDistance1());
            txt += " faulty_shapes=" + std::to_string(r.GetFaultyShapes1().Size());
            list.push(txt);
        }
        j["results"] = list;
    }
    return j;
}

Json measure(const TopoDS_Shape& s) {
    Json j = Json::object();
    if (s.IsNull()) { j["null"] = true; return j; }
    j["shape_type"] = shapeTypeName(s.ShapeType());
    j["solids"] = count(s, TopAbs_SOLID);
    j["shells"] = count(s, TopAbs_SHELL);
    j["faces"] = count(s, TopAbs_FACE);
    j["edges"] = count(s, TopAbs_EDGE);
    j["vertices"] = count(s, TopAbs_VERTEX);
    GProp_GProps vp, sp;
    BRepGProp::VolumeProperties(s, vp);
    BRepGProp::SurfaceProperties(s, sp);
    j["volume_mm3"] = vp.Mass();
    j["area_mm2"] = sp.Mass();
    Bnd_Box box;
    BRepBndLib::AddOptimal(s, box, /*useTriangulation*/ false, /*useShapeTolerance*/ false);
    if (!box.IsVoid()) {
        double x0, y0, z0, x1, y1, z1;
        box.Get(x0, y0, z0, x1, y1, z1);
        Json b = Json::array();
        for (double v : {x0, y0, z0, x1, y1, z1}) b.push(v);
        j["bbox_mm"] = b;
    }
    Json det = Json::object();
    const bool ok = isValid(s, &det);
    j["brepcheck_valid"] = ok;
    if (!ok) j["brepcheck_faults"] = det["brepcheck_faults"];
    return j;
}

static std::string fmt(double v) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.4g", std::abs(v) < 1e-9 ? 0.0 : v);
    return buf;
}
static std::string fmt(const gp_XYZ& p) { return "(" + fmt(p.X()) + "," + fmt(p.Y()) + "," + fmt(p.Z()) + ")"; }

std::string describeFace(const TopoDS_Face& f) {
    BRepAdaptor_Surface sa(f, false);
    GProp_GProps sp;
    BRepGProp::SurfaceProperties(f, sp);
    std::string d;
    switch (sa.GetType()) {
    case GeomAbs_Plane: {
        gp_Dir n = sa.Plane().Axis().Direction();
        if (f.Orientation() == TopAbs_REVERSED) n.Reverse();
        d = "Plane n=" + fmt(n.XYZ());
        break;
    }
    case GeomAbs_Cylinder:
        d = "Cylinder r=" + fmt(sa.Cylinder().Radius()) + " axis@" + fmt(sa.Cylinder().Location().XYZ());
        break;
    case GeomAbs_Torus:
        d = "Torus R=" + fmt(sa.Torus().MajorRadius()) + " r=" + fmt(sa.Torus().MinorRadius());
        break;
    case GeomAbs_Cone: d = "Cone"; break;
    case GeomAbs_Sphere: d = "Sphere r=" + fmt(sa.Sphere().Radius()); break;
    case GeomAbs_BezierSurface: d = "Bezier"; break;
    case GeomAbs_BSplineSurface: d = "BSpline"; break;
    case GeomAbs_SurfaceOfRevolution: d = "Revolution"; break;
    case GeomAbs_SurfaceOfExtrusion: d = "Extrusion"; break;
    case GeomAbs_OffsetSurface: d = "Offset"; break;
    default: d = "Other"; break;
    }
    d += " centroid=" + fmt(sp.CentreOfMass().XYZ()) + " area=" + fmt(sp.Mass());
    return d;
}

// --- mesh crack check ------------------------------------------------------

namespace {
struct NodeMerger {
    double tol;
    std::unordered_map<std::uint64_t, std::vector<int>> grid;
    std::vector<gp_Pnt> pts;

    static std::uint64_t key(long long x, long long y, long long z) {
        const std::uint64_t m = (1ull << 21) - 1;
        return ((std::uint64_t(x) & m) << 42) | ((std::uint64_t(y) & m) << 21) | (std::uint64_t(z) & m);
    }
    int add(const gp_Pnt& p) {
        const long long cx = (long long)std::floor(p.X() / tol), cy = (long long)std::floor(p.Y() / tol),
                        cz = (long long)std::floor(p.Z() / tol);
        for (long long dx = -1; dx <= 1; ++dx)
            for (long long dy = -1; dy <= 1; ++dy)
                for (long long dz = -1; dz <= 1; ++dz) {
                    auto it = grid.find(key(cx + dx, cy + dy, cz + dz));
                    if (it == grid.end()) continue;
                    for (int idx : it->second)
                        if (pts[idx].Distance(p) <= tol) return idx;
                }
        const int idx = (int)pts.size();
        pts.push_back(p);
        grid[key(cx, cy, cz)].push_back(idx);
        return idx;
    }
};
} // namespace

static Json crackCheck(const TopoDS_Shape& s, double tol) {
    NodeMerger nm{tol, {}, {}};
    std::vector<std::array<int, 3>> tris;
    int facesWithoutMesh = 0;
    for (TopExp_Explorer ex(s, TopAbs_FACE); ex.More(); ex.Next()) {
        const TopoDS_Face& f = TopoDS::Face(ex.Current());
        TopLoc_Location loc;
        const auto tri = BRep_Tool::Triangulation(f, loc);
        if (tri.IsNull()) { ++facesWithoutMesh; continue; }
        const gp_Trsf tr = loc.Transformation();
        std::vector<int> map(tri->NbNodes() + 1);
        for (int i = 1; i <= tri->NbNodes(); ++i) map[i] = nm.add(tri->Node(i).Transformed(tr));
        const bool rev = f.Orientation() == TopAbs_REVERSED;
        for (int i = 1; i <= tri->NbTriangles(); ++i) {
            int a, b, c;
            tri->Triangle(i).Get(a, b, c);
            if (rev) std::swap(b, c);
            tris.push_back({map[a], map[b], map[c]});
        }
    }
    std::unordered_map<std::uint64_t, int> directed;
    int degenerate = 0;
    double vol6 = 0;
    for (const auto& t : tris) {
        if (t[0] == t[1] || t[1] == t[2] || t[0] == t[2]) { ++degenerate; continue; }
        for (int k = 0; k < 3; ++k) {
            const std::uint64_t u = (std::uint64_t)t[k], v = (std::uint64_t)t[(k + 1) % 3];
            directed[(u << 32) | v]++;
        }
        const gp_XYZ &p0 = nm.pts[t[0]].XYZ(), &p1 = nm.pts[t[1]].XYZ(), &p2 = nm.pts[t[2]].XYZ();
        vol6 += p0.Dot(p1.Crossed(p2));
    }
    int boundary = 0, nonManifold = 0, misoriented = 0;
    for (const auto& [k, n] : directed) {
        const std::uint64_t u = k >> 32, v = k & 0xffffffffull;
        auto it = directed.find((v << 32) | u);
        const int rn = it == directed.end() ? 0 : it->second;
        if (n > 1) ++misoriented;
        if (rn == 0) ++boundary;
        if (n + rn > 2) ++nonManifold;
    }
    Json j = Json::object();
    j["merge_tol_mm"] = tol;
    j["merged_nodes"] = nm.pts.size();
    j["faces_without_mesh"] = facesWithoutMesh;
    j["degenerate_triangles_after_merge"] = degenerate;
    j["boundary_edges"] = boundary;
    j["non_manifold_edges"] = nonManifold;
    j["misoriented_edges"] = misoriented;
    j["watertight"] = facesWithoutMesh == 0 && boundary == 0 && nonManifold == 0 && misoriented == 0;
    j["mesh_volume_mm3"] = vol6 / 6.0;
    return j;
}

Json meshAndCheck(const TopoDS_Shape& s, double linDefl, double angDeflDeg, int runs) {
    Json j = Json::object();
    const double ang = angDeflDeg * 3.14159265358979323846 / 180.0;
    std::vector<double> times;
    for (int r = 0; r <= runs; ++r) {
        BRepTools::Clean(s);
        const auto t0 = Clock::now();
        BRepMesh_IncrementalMesh mesher(s, linDefl, /*isRelative*/ false, ang, /*isInParallel*/ false);
        const double ms = msSince(t0);
        if (r > 0) times.push_back(ms);  // run 0 is the warm-up
        if (r == runs) j["status_flags"] = mesher.GetStatusFlags();
    }
    long long nTri = 0, nNodes = 0;
    for (TopExp_Explorer ex(s, TopAbs_FACE); ex.More(); ex.Next()) {
        TopLoc_Location loc;
        const auto tri = BRep_Tool::Triangulation(TopoDS::Face(ex.Current()), loc);
        if (tri.IsNull()) continue;
        nTri += tri->NbTriangles();
        nNodes += tri->NbNodes();
    }
    j["lin_deflection_mm"] = linDefl;
    j["ang_deflection_deg"] = angDeflDeg;
    j["triangles"] = nTri;
    j["nodes_per_face_sum"] = nNodes;
    j["median_ms"] = median(times);
    j["exact_merge"] = crackCheck(s, 1e-9);
    j["merge_1e-6"] = crackCheck(s, 1e-6);
    j["merge_1e-3"] = crackCheck(s, 1e-3);
    // Parallel meshing once, for information.
    BRepTools::Clean(s);
    const auto t0 = Clock::now();
    BRepMesh_IncrementalMesh par(s, linDefl, false, ang, true);
    j["parallel_once_ms"] = msSince(t0);
    return j;
}

// --- STEP -------------------------------------------------------------------

#ifdef KT_WITH_STEP
static const char* statusName(IFSelect_ReturnStatus st) {
    switch (st) {
    case IFSelect_RetVoid: return "RetVoid";
    case IFSelect_RetDone: return "RetDone";
    case IFSelect_RetError: return "RetError";
    case IFSelect_RetFail: return "RetFail";
    case IFSelect_RetStop: return "RetStop";
    default: return "?";
    }
}

void writeStep(const TopoDS_Shape& s, const std::string& path, bool ap242, Json* info) {
    STEPControl_Writer w;
    DESTEP_Parameters params;
    params.WriteSchema = ap242 ? DESTEP_Parameters::WriteMode_StepSchema_AP242DIS
                               : DESTEP_Parameters::WriteMode_StepSchema_AP214IS;
    const auto t0 = Clock::now();
    const IFSelect_ReturnStatus st = w.Transfer(s, STEPControl_AsIs, params);
    if (st != IFSelect_RetDone) throw std::runtime_error(std::string("STEP transfer failed: ") + statusName(st));
    const IFSelect_ReturnStatus wst = w.Write(path.c_str());
    if (wst != IFSelect_RetDone) throw std::runtime_error(std::string("STEP write failed: ") + statusName(wst));
    if (info) {
        (*info)["schema"] = ap242 ? "AP242DIS" : "AP214IS";
        (*info)["write_ms"] = msSince(t0);
    }
}

TopoDS_Shape readStep(const std::string& path, Json* info) {
    STEPControl_Reader r;
    const auto t0 = Clock::now();
    const IFSelect_ReturnStatus st = r.ReadFile(path.c_str());
    if (st != IFSelect_RetDone) throw std::runtime_error(std::string("STEP read failed: ") + statusName(st));
    const int roots = r.NbRootsForTransfer();
    const int n = r.TransferRoots();
    TopoDS_Shape s = r.OneShape();
    if (info) {
        (*info)["read_ms"] = msSince(t0);
        (*info)["roots"] = roots;
        (*info)["transferred"] = n;
    }
    if (s.IsNull()) throw std::runtime_error("STEP file contains no transferable shape");
    return s;
}

Json stepRoundTrip(const TopoDS_Shape& s, const std::string& path, bool ap242) {
    Json j = Json::object();
    try {
        OCC_CATCH_SIGNALS
        writeStep(s, path, ap242, &j);
        Json rinfo = Json::object();
        TopoDS_Shape back = readStep(path, &rinfo);
        j["read_ms"] = rinfo["read_ms"];
        GProp_GProps a, b;
        BRepGProp::VolumeProperties(s, a);
        BRepGProp::VolumeProperties(back, b);
        j["volume_before_mm3"] = a.Mass();
        j["volume_after_mm3"] = b.Mass();
        j["volume_rel_diff"] = std::abs(b.Mass() - a.Mass()) / std::abs(a.Mass());
        j["faces_before"] = count(s, TopAbs_FACE);
        j["faces_after"] = count(back, TopAbs_FACE);
        j["solids_after"] = count(back, TopAbs_SOLID);
        j["valid_after"] = isValid(back);
        j["ok"] = true;
    } catch (...) {
        j["ok"] = false;
        j["error"] = describeCurrentException();
    }
    return j;
}
#endif

} // namespace kt
