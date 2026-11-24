// Kernel test (SMLib track): JSON output, measurement and selection helpers.
#include "kt.h"

#include <SmApiBrep.h>
#include <SmApiGeneral.h>
#include <SmApiPolygons.h>
#include <SmApiQueries.h>
#include <SmAssertArray.h>
#include <SmBrep.h>
#include <SmEdge.h>
#include <SmFace.h>
#include <SmPoly.h>
#include <SmMessages.h>
#include <SmVertex.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <sstream>

namespace kt
{
const char* StatusName(long s)
{
    switch (s)
    {
        case SM_SUCCESS: return "SM_SUCCESS";
        case SM_ERR: return "SM_ERR";
        case SM_ERR_OUT_OF_MEMORY: return "SM_ERR_OUT_OF_MEMORY";
        case SM_ERR_UNKNOWN: return "SM_ERR_UNKNOWN";
        case SM_ERR_FATAL: return "SM_ERR_FATAL";
        case SM_ERR_ASSERT_FAILURE: return "SM_ERR_ASSERT_FAILURE";
        case SM_ERR_NULL_POINTER: return "SM_ERR_NULL_POINTER";
        case SM_ERR_INVALID_INPUT: return "SM_ERR_INVALID_INPUT";
        case SM_ERR_NON_NULL_OUTPUT_POINTER: return "SM_ERR_NON_NULL_OUTPUT_POINTER";
        case SM_ERR_ASSERTVALID_FAILURE: return "SM_ERR_ASSERTVALID_FAILURE";
        case SM_ERR_OUTSIDE_OF_DOMAIN: return "SM_ERR_OUTSIDE_OF_DOMAIN";
        case SM_ERR_NOT_WITHIN_TOLERANCE: return "SM_ERR_NOT_WITHIN_TOLERANCE";
        case SM_ERR_NOT_CONVERGING: return "SM_ERR_NOT_CONVERGING";
        case SM_ERR_BAD_INTERSECTIONS: return "SM_ERR_BAD_INTERSECTIONS";
        case SM_ERR_DEGENERATE_SURFACE: return "SM_ERR_DEGENERATE_SURFACE";
        case SM_ERR_TESS_FAIL_FACE: return "SM_ERR_TESS_FAIL_FACE";
        default: return "SM_ERR_other";
    }
}

namespace
{
thread_local std::string t_trail;
void TrailCallback(SmStatus err, const TCHAR* file, ULONG line, const TCHAR* msg)
{
    if (err == SM_SUCCESS || err == SM_ERR_WARNING || err == SM_ERR_MESSAGE) return;
    if (t_trail.size() > 4000) return;
    std::string f = file ? smos_FromTChar(file) : std::string();
    const size_t cut = f.find_last_of("/\\");
    if (cut != std::string::npos) f = f.substr(cut + 1);
    if (!t_trail.empty()) t_trail += "; ";
    t_trail += std::string(StatusName(err)) + " at " + f + ":" + std::to_string(line);
    if (msg && *msg) t_trail += " (" + smos_FromTChar(msg) + ")";
}
} // namespace

void InstallErrorTrail() { smos_SetErrorCallback(TrailCallback); }
std::string TakeErrorTrail()
{
    std::string s;
    s.swap(t_trail);
    return s;
}

void Check(long status, const char* op)
{
    if (status != SM_SUCCESS)
    {
        std::ostringstream m;
        m << op << " returned " << status << " (" << StatusName(status) << ")";
        throw KernelError(status, op, m.str());
    }
}

std::string Quote(const std::string& s)
{
    std::string o = "\"";
    for (char c : s)
    {
        switch (c)
        {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20)
                {
                    char b[8];
                    std::snprintf(b, sizeof b, "\\u%04x", c);
                    o += b;
                }
                else
                    o += c;
        }
    }
    return o + "\"";
}

std::string Fmt(double v)
{
    if (!std::isfinite(v)) return "null";
    char b[64];
    std::snprintf(b, sizeof b, "%.10g", v);
    return b;
}

Json& Json::Num(const std::string& k, double v) { m_items.emplace_back(k, Fmt(v)); return *this; }
Json& Json::Int(const std::string& k, long long v) { m_items.emplace_back(k, std::to_string(v)); return *this; }
Json& Json::Str(const std::string& k, const std::string& v) { m_items.emplace_back(k, Quote(v)); return *this; }
Json& Json::Bool(const std::string& k, bool v) { m_items.emplace_back(k, v ? "true" : "false"); return *this; }
Json& Json::Raw(const std::string& k, const std::string& j) { m_items.emplace_back(k, j); return *this; }
Json& Json::NumArr(const std::string& k, const std::vector<double>& v)
{
    std::string s = "[";
    for (size_t i = 0; i < v.size(); ++i) s += (i ? "," : "") + Fmt(v[i]);
    return Raw(k, s + "]");
}
Json& Json::StrArr(const std::string& k, const std::vector<std::string>& v)
{
    std::string s = "[";
    for (size_t i = 0; i < v.size(); ++i) s += (i ? "," : "") + Quote(v[i]);
    return Raw(k, s + "]");
}
std::string Json::Dump() const
{
    std::string s = "{";
    for (size_t i = 0; i < m_items.size(); ++i) s += (i ? "," : "") + Quote(m_items[i].first) + ":" + m_items[i].second;
    return s + "}";
}

double Median(std::vector<double> v)
{
    if (v.empty()) return NAN;
    std::sort(v.begin(), v.end());
    const size_t n = v.size();
    return n % 2 ? v[n / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

BrepPtr& BrepPtr::operator=(BrepPtr&& o) noexcept
{
    if (this != &o)
    {
        reset(o.p);
        o.p = nullptr;
    }
    return *this;
}
BrepPtr::~BrepPtr() { reset(); }
void BrepPtr::reset(SmBrep* b)
{
    if (p && p != b) delete p;
    p = b;
}

static std::string ReportText(const SmAssertReport& r)
{
    TCHAR msg[SM_TBLOCK_SIZE];
    r.FormatLogMessage(msg, SM_TBLOCK_SIZE);
    std::ostringstream o;
    o << smos_FromTChar(r.GetAssertTypeString()) << " " << smos_FromTChar(r.m_sOwnerTypeString) << "::Test #" << r.GetTestIndex()
      << " " << smos_FromTChar(r.m_pName) << " - " << smos_FromTChar(msg);
    std::string s = o.str();
    s.erase(std::remove(s.begin(), s.end(), '\n'), s.end());
    return s;
}

Metrics Measure(SmBrep* b)
{
    Metrics m;
    if (!b) return m;
    m.haveBrep = true;
    SmTArray<SmFace*> faces;
    SmTArray<SmEdge*> edges;
    SmTArray<SmVertex*> verts;
    SmApiGetFaces(b, faces);
    SmApiGetEdges(b, edges);
    b->GetVertices(verts);
    m.faces = faces.GetSize();
    m.edges = edges.GetSize();
    m.vertices = verts.GetSize();

    SmBoolean man = FALSE;
    if (SmApiBrepIsManifoldSolid(b, man) == SM_SUCCESS) m.manifoldSolid = man == TRUE;
    long solids = 0, voids = 0;
    if (SmApiBrepMaterialCensus(b, solids, voids) == SM_SUCCESS)
    {
        m.solidRegions = solids;
        m.voidRegions = voids;
    }
    std::string qerr;
    double v = 0, a = 0;
    long st = SmApiBrepComputeVolume(b, 1.0e-6, v);
    if (st == SM_SUCCESS) m.volume = v;
    else qerr += std::string("volume: ") + StatusName(st) + "; ";
    st = SmApiBrepComputeArea(b, 1.0e-6, a);
    if (st == SM_SUCCESS) m.area = a;
    else qerr += std::string("area: ") + StatusName(st) + "; ";
    SmPoint3d lo, hi;
    st = SmApiBrepBoundingBox(b, TRUE, lo, hi);
    if (st == SM_SUCCESS)
    {
        for (int i = 0; i < 3; ++i)
        {
            m.bbMin[i] = lo[i];
            m.bbMax[i] = hi[i];
        }
    }
    else qerr += std::string("bbox: ") + StatusName(st) + "; ";
    m.queryError = qerr;

    // The kernel's own consistency checker: level 0 (fewest tests) and level 2 (all tests).
    {
        SmAssertArray a0;
        m.assertValidL0 = b->AssertValid(&a0, SM_LEVEL_0, SM_WALK) == TRUE;
    }
    {
        SmAssertArray a2;
        m.assertValidL2 = b->AssertValid(&a2, SM_LEVEL_2, SM_WALK) == TRUE;
        m.reportsL2 = a2.GetSize();
        for (ULONG i = 0; i < a2.GetSize() && m.firstReports.size() < 6; ++i)
        {
            const SmAssertReport* r = a2.GetAt(i);
            if (r) m.firstReports.push_back(ReportText(*r));
        }
    }
    return m;
}

Json Metrics::ToJson() const
{
    Json j;
    j.Bool("haveBrep", haveBrep);
    if (!haveBrep) return j;
    j.Num("volume_mm3", volume).Num("area_mm2", area);
    j.Int("faces", faces).Int("edges", edges).Int("vertices", vertices);
    j.NumArr("bboxMin", { bbMin[0], bbMin[1], bbMin[2] }).NumArr("bboxMax", { bbMax[0], bbMax[1], bbMax[2] });
    j.Bool("isManifoldSolid", manifoldSolid).Int("solidRegions", solidRegions).Int("voidRegions", voidRegions);
    j.Bool("assertValidLevel0", assertValidL0).Bool("assertValidLevel2", assertValidL2).Int("assertReportsLevel2", reportsL2);
    j.StrArr("firstAssertReports", firstReports);
    if (!queryError.empty()) j.Str("queryError", queryError);
    return j;
}

Json CaseResult::ToJson() const
{
    Json j;
    j.Str("id", id).Str("outcome", outcome).Str("detail", detail);
    if (!opMs.empty())
    {
        j.Num("opMedian_ms", Median(opMs)).NumArr("op_ms", opMs);
        j.Num("totalMedian_ms", Median(totalMs)).NumArr("total_ms", totalMs);
    }
    j.Obj("metrics", metrics.ToJson());
    if (!extra.Empty()) j.Obj("extra", extra);
    return j;
}

static bool Inside(const SmPoint3d& lo, const SmPoint3d& hi, const double a[3], const double b[3])
{
    for (int i = 0; i < 3; ++i)
        if (lo[i] < a[i] || hi[i] > b[i]) return false;
    return true;
}

std::vector<SmEdge*> AllEdges(SmBrep* b)
{
    SmTArray<SmEdge*> e;
    SmApiGetEdges(b, e);
    std::vector<SmEdge*> r;
    for (ULONG i = 0; i < e.GetSize(); ++i) r.push_back(e[i]);
    return r;
}
std::vector<SmFace*> AllFaces(SmBrep* b)
{
    SmTArray<SmFace*> f;
    SmApiGetFaces(b, f);
    std::vector<SmFace*> r;
    for (ULONG i = 0; i < f.GetSize(); ++i) r.push_back(f[i]);
    return r;
}
std::vector<SmEdge*> EdgesInBox(SmBrep* b, const double lo[3], const double hi[3])
{
    std::vector<SmEdge*> r;
    for (SmEdge* e : AllEdges(b))
    {
        SmPoint3d a, c;
        if (SmApiEdgeBoundingBox(e, TRUE, a, c) == SM_SUCCESS && Inside(a, c, lo, hi)) r.push_back(e);
    }
    return r;
}
std::vector<SmFace*> FacesInBox(SmBrep* b, const double lo[3], const double hi[3])
{
    std::vector<SmFace*> r;
    for (SmFace* f : AllFaces(b))
    {
        SmPoint3d a, c;
        if (SmApiFaceBoundingBox(f, TRUE, a, c) == SM_SUCCESS && Inside(a, c, lo, hi)) r.push_back(f);
    }
    return r;
}

MeshStats Tessellate(SmBrep* b, int runs, double chord, double angleDeg)
{
    MeshStats s;
    SmTessellationParams p;
    p.dChordHeightTol = chord;
    p.dCurveAngleTolDeg = angleDeg;
    p.dSurfaceAngleTolDeg = angleDeg;
    for (int r = 0; r <= runs; ++r)
    {
        SmPolyBrep* poly = nullptr;
        SmTArray<SmTessellationFailure> failures;
        SmTessellationReport rep;
        const auto t0 = Clock::now();
        const long st = SmApiTessellate(b, poly, p, FALSE, &failures, &rep);
        const double ms = MsSince(t0);
        if (st != SM_SUCCESS || !poly)
        {
            s.ok = false;
            s.error = std::string("SmApiTessellate returned ") + StatusName(st) + ", failed faces: " + std::to_string(failures.GetSize());
            delete poly;
            return s;
        }
        if (r > 0) s.ms.push_back(ms);
        if (r == runs)
        {
            SmTArray<SmPolyFace*> pf;
            poly->GetPolyFaces(pf);
            s.polyFaces = pf.GetSize();
            unsigned long tri = 0;
            for (ULONG i = 0; i < pf.GetSize(); ++i)
            {
                // A polygon with n vertices counts as n - 2 triangles.
                SmTArray<SmPolyVertex*> pv;
                pf[i]->GetPolyVertices(pv);
                tri += pv.GetSize() >= 3 ? pv.GetSize() - 2 : 0;
            }
            s.triangles = tri;
            SmTArray<SmPoint3d> pp;
            poly->GetPolyPoints(pp);
            s.points = pp.GetSize();
            s.laminaEdges = rep.laminaEdges;
            s.spineEdges = rep.spineEdges;
            s.outputManifold = rep.outputManifold == TRUE;
            s.inputManifold = rep.inputManifold == TRUE;
            double vol = 0;
            if (SmApiPolyBrepComputeVolume(poly, vol) == SM_SUCCESS) s.meshVolume = vol;
            s.ok = true;
        }
        delete poly;
    }
    return s;
}

Json MeshStats::ToJson() const
{
    Json j;
    j.Bool("ok", ok);
    if (!ok)
    {
        j.Str("error", error);
        return j;
    }
    j.Int("triangles", triangles).Int("polyFaces", polyFaces).Int("points", points);
    j.Int("laminaPolyEdges", laminaEdges).Int("spinePolyEdges", spineEdges);
    j.Bool("outputManifold", outputManifold).Bool("inputManifold", inputManifold);
    j.Bool("watertight", outputManifold && laminaEdges == 0);
    j.Num("meshVolume_mm3", meshVolume);
    j.Num("median_ms", Median(ms)).NumArr("ms", ms);
    return j;
}
} // namespace kt
