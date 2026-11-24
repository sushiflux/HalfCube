// Kernel test (SMLib track): the fixed test parts P1 to P4 plus E1 and E2.
// Every part is built as described in spikes/kerntest/PARTS.md (millimetres, Z up).
#include "kt.h"

#include <SmApiBrep.h>
#include <SmApiCurves.h>
#include <SmApiFillets.h>
#include <SmApiGeneral.h>
#include <SmApiImportExport.h>
#include <SmApiPrimitives.h>
#include <SmApiQueries.h>
#include <SmAttribute.h>
#include <SmBSplineCurve.h>
#include <SmBSplineSurface.h>
#include <SmBrep.h>
#include <SmCurve.h>
#include <SmEdge.h>
#include <SmFace.h>
#include <SmFilletExecutive.h>
#include <SmLine.h>
#include <SmPrimitiveCreation.h>
#include <SmSurface.h>
#include <SmVector3d.h>

#include <algorithm>
#include <cmath>
#include <set>
#include <sstream>

namespace kt
{
namespace
{
constexpr double kPi = 3.14159265358979323846;
constexpr unsigned long kTagAttr = 20001; // application attribute id (> 10000, see SmAttribute.h)

const SmContext& Ctx() { return *SmApiGetOrCreateContext(); }

template <class T> SmTArray<T> ToT(const std::vector<T>& v)
{
    SmTArray<T> a;
    for (const T& x : v) a.Add(x);
    return a;
}

BrepPtr MakeBox(double x, double y, double z, double dx, double dy, double dz)
{
    SmBrep* b = nullptr;
    Check(SmApiCreateBox(SmVector3d(x, y, z), dx, dy, dz, b), "SmApiCreateBox");
    return BrepPtr(b);
}

BrepPtr MakeCylZ(double cx, double cy, double z0, double r, double h)
{
    SmBrep* b = nullptr;
    Check(SmApiCreateCylinder(SmVector3d(cx, cy, z0), r, h, b), "SmApiCreateCylinder");
    return BrepPtr(b);
}

// a := a - b. On success the API deletes b and returns a in place.
void Subtract(BrepPtr& a, BrepPtr& b)
{
    SmBrep* res = nullptr;
    const long st = SmApiBooleanDifference(a.get(), b.get(), res);
    if (st == SM_SUCCESS) b.release();
    Check(st, "SmApiBooleanDifference");
    if (res != a.get()) a.reset(res);
}

// Box from (x0,y0,0) with a vertical through hole (cutter overlaps both caps by 1 mm).
BrepPtr BoxWithHole(double dx, double dy, double dz, double cx, double cy, double r)
{
    BrepPtr box = MakeBox(0, 0, 0, dx, dy, dz);
    BrepPtr cyl = MakeCylZ(cx, cy, -1.0, r, dz + 2.0);
    Subtract(box, cyl);
    return box;
}

std::vector<SmEdge*> CircleEdgesAtZ(SmBrep* b, double cx, double cy, double r, double z)
{
    const double e = 1e-3;
    const double lo[3] = { cx - r - e, cy - r - e, z - e }, hi[3] = { cx + r + e, cy + r + e, z + e };
    return EdgesInBox(b, lo, hi);
}

std::vector<SmFace*> PlanarFacesAtZ(SmBrep* b, double z)
{
    const double e = 1e-3;
    const double lo[3] = { -1e9, -1e9, z - e }, hi[3] = { 1e9, 1e9, z + e };
    return FacesInBox(b, lo, hi);
}

// Runs build() once as warm-up and opts.runs times timed. build() returns the part and
// reports the time of the operation under test through its argument.
CaseResult Timed(const std::string& id, const RunOptions& opts, const std::function<BrepPtr(double&)>& build, BrepPtr& last)
{
    CaseResult r;
    r.id = id;
    for (int i = 0; i <= opts.runs; ++i)
    {
        double op = 0;
        TakeErrorTrail();
        const auto t0 = Clock::now();
        BrepPtr p;
        try
        {
            p = build(op);
        }
        catch (const KernelError& e)
        {
            r.outcome = "fail-clean";
            r.detail = std::string("kernel error: ") + e.what();
            r.extra.Int("status", e.status).Str("statusName", StatusName(e.status)).Str("failedCall", e.op).Int("failedOnRun", i);
            r.extra.Str("kernelTrail", TakeErrorTrail());
            r.opMs.clear();
            r.totalMs.clear();
            return r;
        }
        const double total = MsSince(t0);
        if (i > 0)
        {
            r.opMs.push_back(op);
            r.totalMs.push_back(total);
        }
        if (i == opts.runs) last = std::move(p);
    }
    r.outcome = "pending-validation";
    return r;
}

// Validity verdict: kernel AssertValid (level 2 = all tests), is-manifold-solid and the
// material census (every test part is exactly one solid region without voids).
void Judge(CaseResult& r, SmBrep* b, double expectedVolume = NAN, double relTol = 0.01)
{
    r.metrics = Measure(b);
    std::ostringstream d;
    const Metrics& m = r.metrics;
    const bool valid = m.manifoldSolid && m.assertValidL2 && m.solidRegions == 1 && m.voidRegions == 0;
    d << "volume " << m.volume << " mm3, faces " << m.faces << ", edges " << m.edges << ", AssertValid L0 "
      << (m.assertValidL0 ? "ok" : "FAILED") << ", L2 " << (m.assertValidL2 ? "ok" : "FAILED") << " (" << m.reportsL2
      << " reports), manifold solid " << (m.manifoldSolid ? "yes" : "no") << ", census " << m.solidRegions << " solid / " << m.voidRegions << " void";
    bool volOk = true;
    if (std::isfinite(expectedVolume))
    {
        const double rel = (m.volume - expectedVolume) / expectedVolume;
        d << ", expected volume " << expectedVolume << " (rel. diff " << rel << ")";
        r.extra.Num("expectedVolume_mm3", expectedVolume).Num("volumeRelDiff", rel);
        volOk = std::fabs(rel) <= relTol;
    }
    r.outcome = (valid && volOk) ? "pass" : "invalid-result";
    if (valid && !volOk) d << " -- kernel accepts the solid but its volume is wrong";
    r.detail = d.str();
}

void SaveNative(const RunOptions& o, const std::string& id, SmBrep* b, Json& extra)
{
    if (o.outDir.empty() || !b) return;
    const std::string path = o.outDir + "/" + id + ".smb";
#ifdef _UNICODE
    std::wstring w(path.begin(), path.end());
    const long st = SmApiWriteBrepToFile(b, w.c_str(), TRUE);
#else
    const long st = SmApiWriteBrepToFile(b, path.c_str(), TRUE);
#endif
    extra.Str("nativeFile", id + ".smb").Str("nativeWrite", StatusName(st));
}

// ---------------------------------------------------------------- E1 helpers
void TagFaces(SmBrep* b, long base)
{
    long i = 0;
    for (SmFace* f : AllFaces(b)) f->AddAttribute(new (Ctx()) SmLongAttribute(kTagAttr, base + (i++), SM_AB_COPY));
}

std::string FaceLabel(SmFace* f)
{
    SmPoint3d lo, hi;
    SmApiFaceBoundingBox(f, TRUE, lo, hi);
    double a = 0;
    SmApiFaceComputeArea(f, 1e-6, a);
    std::ostringstream o;
    o << smos_FromTChar(f->GetSurface()->GetClassString()) << " bbox(" << lo[0] << "," << lo[1] << "," << lo[2] << ")-(" << hi[0] << "," << hi[1]
      << "," << hi[2] << ") area " << a;
    return o.str();
}

long TagOf(SmFace* f)
{
    const SmAttribute* a = f->FindAttribute(kTagAttr);
    if (!a) return -1;
    const long* v = a->GetLongElementsAddress();
    return v ? v[0] : -1;
}

struct FaceSnap
{
    long tag;
    std::string label;
};
std::vector<FaceSnap> Snap(SmBrep* b)
{
    std::vector<FaceSnap> s;
    for (SmFace* f : AllFaces(b)) s.push_back({ TagOf(f), FaceLabel(f) });
    return s;
}

// Map original tags -> result faces. Untagged result faces were generated by the operation.
Json HistoryMap(const std::vector<FaceSnap>& before, const std::vector<FaceSnap>& after)
{
    Json j;
    std::string origin = "[";
    bool first = true;
    std::set<long> seen;
    for (const FaceSnap& a : before)
    {
        std::vector<std::string> res;
        for (const FaceSnap& b : after)
            if (b.tag == a.tag) res.push_back(b.label);
        seen.insert(a.tag);
        Json e;
        e.Int("tag", a.tag).Str("before", a.label).StrArr("after", res).Str("kind", res.empty() ? "deleted" : (res.size() > 1 ? "split" : "kept-or-modified"));
        origin += (first ? "" : ",") + e.Dump();
        first = false;
    }
    origin += "]";
    std::vector<std::string> gen, foreign;
    for (const FaceSnap& b : after)
    {
        if (b.tag < 0) gen.push_back(b.label);
        else if (!seen.count(b.tag)) foreign.push_back(std::to_string(b.tag) + ": " + b.label);
    }
    j.Raw("originalFaces", origin).StrArr("generatedFaces(untagged)", gen).StrArr("tagsFromOtherOperand", foreign);
    return j;
}

// ---------------------------------------------------------------- P1
CaseResult P1a(const RunOptions& o)
{
    BrepPtr last;
    CaseResult r = Timed("P1a", o, [](double& op) {
        BrepPtr b = BoxWithHole(80, 50, 20, 40, 25, 10);
        std::vector<SmEdge*> e = CircleEdgesAtZ(b.get(), 40, 25, 10, 20);
        if (e.empty()) throw KernelError(SM_ERR, "select", "hole top edge not found");
        SmTArray<SmEdge*> ea = ToT(e);
        const auto t0 = Clock::now();
        Check(SmApiFilletEdges(b.get(), ea, 3.0, 1, 1, 1.0), "SmApiFilletEdges r=3");
        op = MsSince(t0);
        return b;
    }, last);
    if (!last.get()) return r;
    // Expected: box minus hole minus the fillet ring (Pappus: area r^2(1-pi/4), centroid at 10 + r(10-3pi)/(12-3pi)).
    const double rr = 3, ring = rr * rr * (1 - kPi / 4), cen = 10 + rr * (10 - 3 * kPi) / (12 - 3 * kPi);
    Judge(r, last.get(), 80.0 * 50 * 20 - kPi * 100 * 20 - 2 * kPi * cen * ring);
    r.extra.Int("selectedEdges", (long long)CircleEdgesAtZ(last.get(), 40, 25, 13, 20).size());
    SaveNative(o, "P1a", last.get(), r.extra);
    return r;
}

// Fillet radius actually built at a given angle round the hole: distance from the hole axis
// to the inner boundary of the top face (z = 20), minus the hole radius.
std::vector<double> RealisedRadii(SmBrep* b, double cx, double cy, double holeR, const std::vector<double>& anglesDeg)
{
    std::vector<double> out(anglesDeg.size(), NAN);
    std::vector<SmFace*> tops = PlanarFacesAtZ(b, 20.0);
    for (SmFace* f : tops)
    {
        SmTArray<ULONG> counts;
        SmTArray<SmEdge*> edges;
        SmTArray<SmOrientType> orient;
        if (SmApiFaceGetBoundaryLoops(f, counts, edges, orient) != SM_SUCCESS) continue;
        for (ULONG i = 0; i < edges.GetSize(); ++i)
        {
            SmEdge* e = edges[i];
            double t0 = 0, t1 = 0;
            if (SmApiEdgeParameterRange(e, t0, t1) != SM_SUCCESS) continue;
            const int n = 2000;
            for (int k = 0; k <= n; ++k)
            {
                SmVector3d* p = new SmVector3d();
                SmVector3d* d1 = nullptr;
                SmVector3d* d2 = nullptr;
                if (SmApiEvaluateCurve(e->GetCurve(), t0 + (t1 - t0) * k / n, p, d1, d2) == SM_SUCCESS)
                {
                    const double dx = (*p)[0] - cx, dy = (*p)[1] - cy;
                    const double rad = std::sqrt(dx * dx + dy * dy);
                    if (rad < holeR + 20)
                    {
                        double ang = std::atan2(dy, dx) * 180 / kPi;
                        if (ang < 0) ang += 360;
                        for (size_t a = 0; a < anglesDeg.size(); ++a)
                        {
                            double diff = std::fabs(ang - anglesDeg[a]);
                            diff = std::min(diff, 360 - diff);
                            if (diff < 0.2) out[a] = rad - holeR;
                        }
                    }
                }
                delete p;
            }
        }
    }
    return out;
}

// smooth = false: the PARTS.md law (linear 2 -> 5 -> 2, degree-1 law curve).
// smooth = true: diagnostic variant only, r = 3.5 - 1.5 cos(2 pi (s - s0)), interpolated by a
// cubic law curve (same 2 / 5 extremes, no kinks), to see whether the law kinks cause the defect.
CaseResult P1bImpl(const std::string& id, const RunOptions& o, bool smooth)
{
    BrepPtr last;
    Json lawInfo;
    CaseResult r = Timed(id, o, [&lawInfo, smooth](double& op) {
        lawInfo = Json();
        BrepPtr b = BoxWithHole(80, 50, 20, 40, 25, 10);
        std::vector<SmEdge*> e = CircleEdgesAtZ(b.get(), 40, 25, 10, 20);
        if (e.size() != 1) throw KernelError(SM_ERR, "select", "expected one closed hole edge, found " + std::to_string(e.size()));
        SmEdge* edge = e[0];
        // Law parameter = normalised edge parameter (SmBSplineFilletLaw::Evaluate maps the edge
        // interval linearly onto the law's edge map). Put r = 2 at the parameter of (50,25,20)
        // and r = 5 half a parameter period further, linear in between (degree-1 law curve).
        double t0 = 0, t1 = 0;
        Check(SmApiEdgeParameterRange(edge, t0, t1), "SmApiEdgeParameterRange");
        SmPoint3d cp;
        double tp = 0, dist = 0;
        Check(SmApiEdgeClosestPoint(edge, SmPoint3d(50, 25, 20), cp, tp, dist), "SmApiEdgeClosestPoint");
        double s0 = (tp - t0) / (t1 - t0);
        if (s0 < 1e-9 || s0 > 1 - 1e-9) s0 = 0;
        const double s1 = s0 < 0.5 ? s0 + 0.5 : s0 - 0.5;
        auto rAt = [&](double s) { // periodic triangle wave: 2 at s0, 5 at s1
            double d = std::fabs(s - s0);
            d = std::min(d, 1 - d);
            return 2.0 + 3.0 * (d / 0.5);
        };
        std::vector<double> ks = { 0.0 };
        if (s0 > 1e-9) ks.push_back(s0);
        ks.push_back(s1);
        std::sort(ks.begin(), ks.end());
        ks.push_back(1.0);
        SmTArray<SmPoint3d> pts;
        SmTArray<double> knots;
        SmTArray<ULONG> mult;
        for (size_t i = 0; i < ks.size(); ++i)
        {
            pts.Add(SmPoint3d(rAt(ks[i]), 0, 0));
            knots.Add(ks[i]);
            mult.Add((i == 0 || i + 1 == ks.size()) ? 2 : 1);
        }
        SmBSplineCurve* lawCurve = nullptr;
        if (!smooth)
            Check(SmApiCreateCanonicalCurve(pts, knots, mult, nullptr, 1, SM_CF_POLYLINE_FORM, lawCurve), "SmApiCreateCanonicalCurve (law)");
        else
        {
            SmTArray<SmPoint3d> sp;
            const int n = 32;
            for (int k = 0; k <= n; ++k)
                sp.Add(SmPoint3d(3.5 - 1.5 * std::cos(2 * kPi * ((double)k / n - s0)), 0, 0));
            SmCurve* c = nullptr;
            Check(SmApiCreateCurveInterpPoints(sp, c, SM_CP_UNIFORM), "SmApiCreateCurveInterpPoints (smooth law)");
            lawCurve = (c && c->IsKindOf(SmBSplineCurve_TYPE)) ? static_cast<SmBSplineCurve*>(c) : nullptr;
            if (!lawCurve) { delete c; throw KernelError(SM_ERR, "law", "interpolated law is not a B-spline curve"); }
        }
        lawInfo.Num("edgeParamMin", t0).Num("edgeParamMax", t1).Num("sAt_50_25_20", s0).NumArr("lawKnots", ks);
        std::vector<double> rv;
        for (double k : ks) rv.push_back(rAt(k));
        lawInfo.NumArr("lawRadii", rv);
        lawInfo.Str("lawKind", smooth ? "smooth cosine law, cubic interpolation of 33 samples (diagnostic, not the PARTS.md law)" : "linear 2-5-2 law, degree-1 B-spline");
        // The edge map sends the normalised edge parameter into the law curve's natural interval.
        const SmExtent1d lawIvl = lawCurve->GetNaturalInterval();
        lawInfo.Num("lawParamMin", lawIvl.GetMin()).Num("lawParamMax", lawIvl.GetMax());
        SmExtent1d map(lawIvl.GetMin(), lawIvl.GetMax());
        SmBSplineFilletLaw* law = new (Ctx()) SmBSplineFilletLaw(lawCurve, map); // consumes the curve
        SmTArray<SmEdge*> ea = ToT(e);
        const auto ts = Clock::now();
        {
            SmFilletExecutive ex(Ctx(), b.get());
            ex.SetDoGlobalMerge(TRUE);
            const long st1 = ex.SetFilletParameters(b.get(), ea, SM_FSG_CIRCULAR, SM_FS_VARIABLE_RADIUS, 2.0, law, -1, -1, -1, -1, 1);
            if (st1 != SM_SUCCESS) { delete law; Check(st1, "SmFilletExecutive::SetFilletParameters (variable)"); }
            const long st2 = ex.DoFillet();
            if (st2 != SM_SUCCESS) { delete law; Check(st2, "SmFilletExecutive::DoFillet (variable)"); }
            b.get()->StitchAndOrient();
        }
        op = MsSince(ts);
        delete law;
        return b;
    }, last);
    r.extra.Obj("law", lawInfo);
    r.extra.Str("api", "SMLib level: SmFilletExecutive + SmBSplineFilletLaw (SM_API only offers a linear start/end law: SmApiVariableRadiusFillet)");
    if (!last.get()) return r;
    Judge(r, last.get());
    const std::vector<double> ang = { 0, 45, 90, 135, 180, 225, 270, 315 };
    const std::vector<double> got = RealisedRadii(last.get(), 40, 25, 10, ang);
    r.extra.NumArr("checkAnglesDeg", ang).NumArr("realisedRadius_mm", got);
    std::vector<double> want;
    for (double a : ang) want.push_back(smooth ? 3.5 - 1.5 * std::cos(a * kPi / 180) : 2.0 + 3.0 * (std::min(a, 360 - a) / 180.0));
    r.extra.NumArr("wantedRadius_mm", want);
    SaveNative(o, id, last.get(), r.extra);
    return r;
}

CaseResult P1b(const RunOptions& o) { return P1bImpl("P1b", o, false); }
CaseResult P1b_smooth(const RunOptions& o) { return P1bImpl("P1b_smooth", o, true); }

CaseResult P1c(const RunOptions& o)
{
    BrepPtr last;
    CaseResult r = Timed("P1c", o, [](double& op) {
        BrepPtr b = MakeBox(0, 0, 0, 40, 40, 40);
        std::vector<SmEdge*> e = AllEdges(b.get());
        SmTArray<SmEdge*> ea = ToT(e);
        const auto t0 = Clock::now();
        Check(SmApiFilletEdges(b.get(), ea, 5.0, 1, 1, 1.0), "SmApiFilletEdges r=5 (12 edges)");
        op = MsSince(t0);
        return b;
    }, last);
    if (!last.get()) return r;
    const double a = 40, rr = 5, c = a - 2 * rr;
    Judge(r, last.get(), c * c * c + 6 * c * c * rr + 3 * kPi * rr * rr * c + 4.0 / 3.0 * kPi * rr * rr * rr);
    SaveNative(o, "P1c", last.get(), r.extra);
    return r;
}

CaseResult P1d(const RunOptions& o, double radius, const std::string& id)
{
    BrepPtr last;
    CaseResult r = Timed(id, o, [radius](double& op) {
        BrepPtr b = BoxWithHole(80, 50, 20, 14, 25, 10);
        std::vector<SmEdge*> e = CircleEdgesAtZ(b.get(), 14, 25, 10, 20);
        if (e.empty()) throw KernelError(SM_ERR, "select", "hole top edge not found");
        SmTArray<SmEdge*> ea = ToT(e);
        const auto t0 = Clock::now();
        Check(SmApiFilletEdges(b.get(), ea, radius, 1, 1, 1.0), "SmApiFilletEdges");
        op = MsSince(t0);
        return b;
    }, last);
    if (!last.get())
    {
        // State of the input after the failed call: is it still a valid solid?
        BrepPtr b = BoxWithHole(80, 50, 20, 14, 25, 10);
        std::vector<SmEdge*> e = CircleEdgesAtZ(b.get(), 14, 25, 10, 20);
        SmTArray<SmEdge*> ea = ToT(e);
        const long st = SmApiFilletEdges(b.get(), ea, radius, 1, 1, 1.0);
        Metrics after = Measure(b.get());
        r.extra.Str("statusAgain", StatusName(st)).Obj("inputAfterFailure", after.ToJson());
        return r;
    }
    const double rr = radius, ring = rr * rr * (1 - kPi / 4), cen = 10 + rr * (10 - 3 * kPi) / (12 - 3 * kPi);
    Judge(r, last.get(), 80.0 * 50 * 20 - kPi * 100 * 20 - 2 * kPi * cen * ring);
    r.extra.Num("bboxMinX", r.metrics.bbMin[0]);
    if (radius > 4.0)
        r.detail += "; note: wall to x=0 is 4 mm, a true r=" + std::to_string(radius) + " fillet cannot fit";
    SaveNative(o, id, last.get(), r.extra);
    return r;
}

// ---------------------------------------------------------------- P2
BrepPtr ShellTopOpen(SmBrep* src, double zTop, SmBoolean extended, double& op)
{
    std::vector<SmFace*> top = PlanarFacesAtZ(src, zTop);
    if (top.size() != 1) throw KernelError(SM_ERR, "select", "expected one top face, found " + std::to_string(top.size()));
    SmTArray<const SmFace*> fa;
    fa.Add(top[0]);
    SmBrep* res = nullptr;
    const auto t0 = Clock::now();
    Check(SmApiShellBrepFull(src, -2.0, extended, TRUE, TRUE, fa, res), extended ? "SmApiShellBrepFull extended=TRUE" : "SmApiShellBrepFull extended=FALSE");
    op = MsSince(t0);
    return BrepPtr(res);
}

CaseResult P2a(const RunOptions& o)
{
    BrepPtr last;
    CaseResult r = Timed("P2a", o, [](double& op) {
        BrepPtr b = MakeBox(0, 0, 0, 60, 40, 30);
        return ShellTopOpen(b.get(), 30, TRUE, op);
    }, last);
    if (!last.get()) return r;
    Judge(r, last.get(), 60.0 * 40 * 30 - 56.0 * 36 * 28);
    SaveNative(o, "P2a", last.get(), r.extra);
    return r;
}

BrepPtr P2bBase()
{
    BrepPtr b = MakeBox(0, 0, 0, 50, 50, 30);
    // The four top edges: horizontal edges at z = 30.
    const double lo[3] = { -1e-3, -1e-3, 30 - 1e-3 }, hi[3] = { 50 + 1e-3, 50 + 1e-3, 30 + 1e-3 };
    std::vector<SmEdge*> e = EdgesInBox(b.get(), lo, hi);
    if (e.size() != 4) throw KernelError(SM_ERR, "select", "expected 4 top edges, found " + std::to_string(e.size()));
    SmTArray<SmEdge*> ea = ToT(e);
    Check(SmApiFilletEdges(b.get(), ea, 5.0, 1, 1, 1.0), "SmApiFilletEdges r=5 (4 top edges)");
    return b;
}

CaseResult P2b(const RunOptions& o, SmBoolean extended, const std::string& id)
{
    BrepPtr last;
    CaseResult r = Timed(id, o, [extended](double& op) {
        BrepPtr b = P2bBase();
        return ShellTopOpen(b.get(), 30, extended, op);
    }, last);
    r.extra.Bool("extendedOffset", extended == TRUE);
    {
        BrepPtr base = P2bBase();
        r.extra.Obj("filletedBaseBeforeShell", Measure(base.get()).ToJson());
    }
    if (!last.get()) return r;
    Judge(r, last.get());
    SaveNative(o, id, last.get(), r.extra);
    return r;
}

CaseResult P2c(const RunOptions& o)
{
    BrepPtr last;
    CaseResult r = Timed("P2c", o, [](double& op) {
        BrepPtr b = BoxWithHole(60, 40, 30, 30, 20, 5);
        return ShellTopOpen(b.get(), 30, TRUE, op);
    }, last);
    if (!last.get()) return r;
    const double outer = 60.0 * 40 * 30 - kPi * 25 * 30, cavity = (56.0 * 36 - kPi * 49) * 28;
    Judge(r, last.get(), outer - cavity);
    // Is the hole wall a tube? Count cylindrical faces around the hole axis.
    int cyl = 0;
    for (SmFace* f : AllFaces(last.get()))
    {
        SmPoint3d lo, hi;
        SmApiFaceBoundingBox(f, TRUE, lo, hi);
        if (lo[0] > 30 - 7.01 && hi[0] < 30 + 7.01 && lo[1] > 20 - 7.01 && hi[1] < 20 + 7.01 && hi[2] - lo[2] > 1) ++cyl;
    }
    r.extra.Int("facesAroundHoleAxis", cyl);
    SaveNative(o, "P2c", last.get(), r.extra);
    return r;
}

// ---------------------------------------------------------------- P3
SmCurve* Circle(double cx, double cy, double z, double rad)
{
    SmBSplineCurve* c = nullptr;
    Check(SmApiCreateCircle(SmPoint3d(cx, cy, z), rad, c), "SmApiCreateCircle");
    return c;
}
SmCurve* Arc(double z, double rad, double a0, double a1)
{
    SmBSplineCurve* c = nullptr;
    Check(SmApiCreateArc(SmPoint3d(0, 0, z), rad, a0, a1, c), "SmApiCreateArc");
    return c;
}
SmCurve* Seg(double x0, double y0, double z0, double x1, double y1, double z1)
{
    SmLine* l = nullptr;
    Check(SmApiCreateLineSegment(SmPoint3d(x0, y0, z0), SmPoint3d(x1, y1, z1), l), "SmApiCreateLineSegment");
    return l;
}
// Rectangle centred on the Z axis, counter-clockwise, starting with the +X side.
std::vector<SmCurve*> Rect(double z, double w, double h)
{
    const double a = w / 2, b = h / 2;
    return { Seg(a, -b, z, a, b, z), Seg(a, b, z, -a, b, z), Seg(-a, b, z, -a, -b, z), Seg(-a, -b, z, a, -b, z) };
}
// Circle split into four arcs whose ends lie on the rays through the rectangle corners.
std::vector<SmCurve*> SplitCircle(double z, double rad, double cornerDeg)
{
    const double c = cornerDeg;
    return { Arc(z, rad, -c, c), Arc(z, rad, c, 180 - c), Arc(z, rad, 180 - c, 180 + c), Arc(z, rad, 180 + c, 360 - c) };
}
void Free(std::vector<SmCurve*>& v)
{
    for (SmCurve* c : v) delete c;
    v.clear();
}

BrepPtr Skin(const std::vector<std::vector<SmCurve*>>& profiles, unsigned long degree, double& op)
{
    SmTArray<ULONG> counts;
    SmTArray<const SmCurve*> all;
    for (const auto& p : profiles)
    {
        counts.Add((ULONG)p.size());
        for (SmCurve* c : p) all.Add(c);
    }
    SmBrep* res = nullptr;
    const auto t0 = Clock::now();
    Check(SmApiCreateSkinPrimitive(counts, all, degree, TRUE, res, nullptr, nullptr, nullptr), "SmApiCreateSkinPrimitive");
    op = MsSince(t0);
    return BrepPtr(res);
}

// One loft attempt with given profile builders.
struct LoftAttempt
{
    std::string name;
    unsigned long degree;
    bool mapped; // TRUE = sections split by hand so their vertices correspond
    std::function<std::vector<std::vector<SmCurve*>>()> make;
};

// Distance from a point to the solid's boundary (kernel closest-point query).
double DistToBrep(SmBrep* b, double x, double y, double z)
{
    SmPoint3d cp;
    double d = NAN;
    if (SmApiBrepClosestPoint(b, SmPoint3d(x, y, z), cp, d) != SM_SUCCESS) return NAN;
    return d;
}

// Side-face surface types and degrees (loft direction is whichever is not the section's).
std::vector<std::string> SurfaceInfo(SmBrep* b)
{
    std::vector<std::string> v;
    for (SmFace* f : AllFaces(b))
    {
        const SmSurface* s = f->GetSurface();
        std::ostringstream o;
        o << smos_FromTChar(s->GetClassString());
        if (const SmBSplineSurface* bs = (s && s->IsKindOf(SmBSplineSurface_TYPE) ? static_cast<const SmBSplineSurface*>(s) : nullptr))
            o << " degU " << bs->GetDegree(SM_SP_U) << " degV " << bs->GetDegree(SM_SP_V) << " cpU " << bs->GetNumberControlPoints(SM_SP_U)
              << " cpV " << bs->GetNumberControlPoints(SM_SP_V);
        v.push_back(o.str());
    }
    return v;
}

// Runs every attempt (each timed) and reports all of them. The case result is the first
// attempt that passes validity AND the geometric check (sections really interpolated,
// no twist); if none does, the last built attempt.
CaseResult Loft(const std::string& id, const RunOptions& o, const std::vector<LoftAttempt>& attempts,
                const std::function<Json(SmBrep*, bool&)>& geomCheck)
{
    std::string log = "[";
    CaseResult chosen;
    chosen.id = id;
    BrepPtr chosenBrep;
    bool haveChosen = false;
    for (size_t i = 0; i < attempts.size(); ++i)
    {
        const LoftAttempt& at = attempts[i];
        BrepPtr last;
        CaseResult r = Timed(id, o, [&at](double& op) {
            auto prof = at.make();
            BrepPtr b;
            try
            {
                b = Skin(prof, at.degree, op);
            }
            catch (...)
            {
                for (auto& p : prof) Free(p);
                throw;
            }
            for (auto& p : prof) Free(p);
            return b;
        }, last);
        Json a;
        a.Str("attempt", at.name).Int("degreeRequested", at.degree).Bool("manualMapping", at.mapped);
        if (!last.get())
        {
            a.Str("outcome", r.outcome).Str("detail", r.detail);
            if (!r.extra.Empty()) a.Obj("error", r.extra);
        }
        else
        {
            Judge(r, last.get());
            bool geomOk = false;
            Json g = geomCheck(last.get(), geomOk);
            a.Str("outcome", r.outcome).Str("detail", r.detail).Obj("geometryCheck", g).Bool("geometryOk", geomOk);
            a.Num("volume_mm3", r.metrics.volume).Num("opMedian_ms", Median(r.opMs)).StrArr("faceSurfaces", SurfaceInfo(last.get()));
            if (!haveChosen && r.outcome == "pass" && geomOk)
            {
                chosen = r;
                chosen.extra = Json();
                chosen.extra.Str("usedAttempt", at.name).Int("usedDegree", at.degree).Bool("usedManualMapping", at.mapped);
                chosenBrep = std::move(last);
                haveChosen = true;
            }
            else if (!haveChosen)
            {
                chosen = r; // keep the latest built one as fallback
                chosen.extra = Json();
                chosen.extra.Str("usedAttempt", at.name);
                if (r.outcome == "pass" && !geomOk)
                {
                    chosen.outcome = "invalid-result";
                    chosen.detail += " -- valid solid but wrong shape (geometry check failed)";
                }
                chosenBrep = std::move(last);
            }
        }
        log += (i ? "," : "") + a.Dump();
    }
    chosen.extra.Raw("attempts", log + "]");
    if (chosenBrep.get()) SaveNative(o, id, chosenBrep.get(), chosen.extra);
    return chosen;
}

CaseResult P3a(const RunOptions& o)
{
    auto natural = [] { return std::vector<std::vector<SmCurve*>>{ { Circle(0, 0, 0, 20) }, Rect(40, 30, 30), { Circle(0, 0, 80, 10) } }; };
    auto mapped = [] { return std::vector<std::vector<SmCurve*>>{ SplitCircle(0, 20, 45), Rect(40, 30, 30), SplitCircle(80, 10, 45) }; };
    // The loft must pass through the square at z = 40: its corners and side midpoints lie on the solid.
    // Twist check: an untwisted loft keeps the axis well inside the solid between the sections.
    // Heuristic threshold: at z = 20 and z = 60 the distance from the axis to the boundary must be at
    // least 90 % of the smaller inradius of the two neighbouring sections (15 and 10 mm). A twisted
    // loft (circle start point matched to a square corner) pinches the cross-section below that.
    auto check = [](SmBrep* b, bool& ok) {
        Json j;
        const double dc = DistToBrep(b, 15, 15, 40), dm = DistToBrep(b, 15, 0, 40), dn = DistToBrep(b, 0, -15, 40);
        const double r20 = DistToBrep(b, 0, 0, 20), r60 = DistToBrep(b, 0, 0, 60);
        j.Num("distCorner_15_15_40", dc).Num("distSideMid_15_0_40", dm).Num("distSideMid_0_m15_40", dn);
        j.Num("axisToBoundary_z20", r20).Num("axisToBoundary_z60", r60).Str("twistRule", "axisToBoundary_z20 >= 13.5 and axisToBoundary_z60 >= 9");
        ok = dc < 1e-3 && dm < 1e-3 && dn < 1e-3 && r20 >= 13.5 && r60 >= 9.0;
        return j;
    };
    return Loft("P3a", o,
                { { "1-4-1 curves as given (circle starts at +X), degree 2", 2, false, natural },
                  { "circles split at the square's corner rays (4-4-4), degree 2", 2, true, mapped } },
                check);
}

CaseResult P3b(const RunOptions& o)
{
    const double corner = std::atan2(10.0, 20.0) * 180 / kPi;
    auto natural = [] { return std::vector<std::vector<SmCurve*>>{ Rect(0, 40, 20), { Circle(0, 0, 50, 15) } }; };
    auto mapped = [corner] { return std::vector<std::vector<SmCurve*>>{ Rect(0, 40, 20), SplitCircle(50, 15, corner) }; };
    // Untwisted: the rectangle corner (20,10,0) runs to the circle point on the same ray.
    // For a two-section skin the halfway point of that line lies on the solid.
    auto check = [corner](SmBrep* b, bool& ok) {
        Json j;
        const double c = corner * kPi / 180;
        const double px = 0.5 * (20 + 15 * std::cos(c)), py = 0.5 * (10 + 15 * std::sin(c));
        const double d = DistToBrep(b, px, py, 25);
        j.NumArr("probe", { px, py, 25 }).Num("distProbe", d);
        ok = d < 0.05;
        return j;
    };
    return Loft("P3b", o,
                { { "4-1 curves as given, degree 3", 3, false, natural },
                  { "4-1 curves as given, degree 1", 1, false, natural },
                  { "circle split at the rectangle's corner rays (4-4), degree 3", 3, true, mapped },
                  { "circle split at the rectangle's corner rays (4-4), degree 1", 1, true, mapped } },
                check);
}

// ---------------------------------------------------------------- P4
CaseResult P4a(const RunOptions& o)
{
    BrepPtr last;
    CaseResult r = Timed("P4a", o, [](double& op) {
        SmCurve* prof = Circle(0, 0, 0, 4);
        Check(SmApiRotate(prof, SmVector3d(0, 0, 0), SmVector3d(0, 1, 0), 90.0), "SmApiRotate (profile into x=0)");
        std::vector<SmCurve*> path = { Seg(0, 0, 0, 50, 0, 0), nullptr, Seg(70, 20, 0, 70, 60, 0) };
        {
            SmBSplineCurve* a = nullptr;
            Check(SmApiCreateArc(SmPoint3d(50, 20, 0), 20, -90, 0, a), "SmApiCreateArc (path)");
            path[1] = a;
        }
        SmTArray<SmCurve*> pa = ToT(path), pr;
        pr.Add(prof);
        SmBrep* res = nullptr;
        const auto t0 = Clock::now();
        const long st = SmApiCreateSweepAlongPlanarPath(pr, pa, TRUE, 3, res);
        op = MsSince(t0);
        delete prof;
        Free(path);
        Check(st, "SmApiCreateSweepAlongPlanarPath");
        return BrepPtr(res);
    }, last);
    r.extra.Str("api", "SmApiCreateSweepAlongPlanarPath (profile curve along line-arc-line, both ends capped)");
    if (!last.get()) return r;
    Judge(r, last.get(), kPi * 16 * (50 + kPi * 20 / 2 + 40));
    SaveNative(o, "P4a", last.get(), r.extra);
    return r;
}

SmBSplineCurve* Helix()
{
    SmBSplineCurve* h = nullptr;
    Check(SmApiCreateHelix(SmPoint3d(0, 0, 0), 50.0, 15.0, 15.0, 5.0, TRUE, 1e-4, h), "SmApiCreateHelix");
    return h;
}

CaseResult P4b(const RunOptions& o, bool pipe)
{
    const std::string id = pipe ? "P4b_pipe" : "P4b";
    BrepPtr last;
    Json helixInfo;
    CaseResult r = Timed(id, o, [pipe, &helixInfo](double& op) {
        SmBSplineCurve* h = Helix();
        SmVector3d* p0 = new SmVector3d();
        SmVector3d* d1 = new SmVector3d();
        SmVector3d* d2 = nullptr;
        double t0 = h->GetNaturalInterval().GetMin();
        SmApiEvaluateCurve(h, t0, p0, d1, d2);
        helixInfo = Json();
        helixInfo.NumArr("start", { (*p0)[0], (*p0)[1], (*p0)[2] }).NumArr("startTangent", { (*d1)[0], (*d1)[1], (*d1)[2] }).Int("controlPoints", h->GetNumberControlPoints()).Int("degree", h->GetDegree());
        delete p0;
        delete d1;
        SmBrep* res = nullptr;
        long st;
        const auto ts = Clock::now();
        if (pipe)
            st = SmApiCreatePipeSweep(2.0, h, TRUE, res);
        else
        {
            SmCurve* prof = Circle(0, 0, 0, 2.0);
            SmTArray<SmCurve*> pr;
            pr.Add(prof);
            SmSweepOptions opt;
            opt.bCapEndsArg = TRUE;
            opt.bTranslationalSweep = FALSE;          // profile turns with the path
            opt.bMoveProfileCenterToPath = TRUE;      // profile centre on the path start
            opt.bOrientProfilePerpendicularToPath = TRUE;
            opt.bMoveToProfile = FALSE;               // keep the result on the path
            st = SmApiCreateCurveSweep(pr, h, nullptr, nullptr, &opt, res, nullptr, nullptr, nullptr);
            delete prof;
        }
        op = MsSince(ts);
        delete h;
        Check(st, pipe ? "SmApiCreatePipeSweep" : "SmApiCreateCurveSweep");
        return BrepPtr(res);
    }, last);
    r.extra.Obj("helix", helixInfo).Num("helixFitTolerance_mm", 1e-4);
    r.extra.Str("orientation", pipe ? "SmApiCreatePipeSweep: circular section built around the path (no orientation option)"
                                    : "SmApiCreateCurveSweep, bTranslationalSweep=FALSE: section frame propagated from the start Z axis along the path tangents (N_CreateSweepScale); TRUE would keep a fixed orientation");
    if (!last.get()) return r;
    const double L = 5 * std::sqrt(std::pow(2 * kPi * 15, 2) + 100.0);
    Judge(r, last.get(), kPi * 4 * L, 0.01);
    SaveNative(o, id, last.get(), r.extra);
    return r;
}

// ---------------------------------------------------------------- E1
CaseResult E1(const RunOptions&)
{
    CaseResult r;
    r.id = "E1";
    try
    {
        BrepPtr box = MakeBox(0, 0, 0, 80, 50, 20);
        BrepPtr cyl = MakeCylZ(40, 25, -1, 10, 22);
        TagFaces(box.get(), 1);   // box faces 1..6
        TagFaces(cyl.get(), 101); // cutter faces 101..
        auto b0 = Snap(box.get());
        auto c0 = Snap(cyl.get());
        Subtract(box, cyl);
        auto b1 = Snap(box.get());
        std::vector<FaceSnap> before = b0;
        before.insert(before.end(), c0.begin(), c0.end());
        r.extra.Obj("holeCut", HistoryMap(before, b1));

        std::vector<SmEdge*> e = CircleEdgesAtZ(box.get(), 40, 25, 10, 20);
        SmTArray<SmEdge*> ea = ToT(e);
        Check(SmApiFilletEdges(box.get(), ea, 3.0, 1, 1, 1.0), "SmApiFilletEdges r=3");
        auto b2 = Snap(box.get());
        r.extra.Obj("fillet", HistoryMap(b1, b2));
        r.outcome = "pass";
        r.detail = "attribute propagation: per-face SmLongAttribute (SM_AB_COPY) set before each operation and read back after it";
        r.metrics = Measure(box.get());
    }
    catch (const KernelError& e)
    {
        r.outcome = "fail-clean";
        r.detail = e.what();
    }
    return r;
}

// ---------------------------------------------------------------- E2
CaseResult E2(const RunOptions& o)
{
    CaseResult r;
    r.id = "E2";
    r.extra.Num("chordTolerance_mm", 0.05).Num("angleTolerance_deg", 20);
    try
    {
        {
            BrepPtr b = BoxWithHole(80, 50, 20, 40, 25, 10);
            std::vector<SmEdge*> e = CircleEdgesAtZ(b.get(), 40, 25, 10, 20);
            SmTArray<SmEdge*> ea = ToT(e);
            Check(SmApiFilletEdges(b.get(), ea, 3.0, 1, 1, 1.0), "SmApiFilletEdges");
            r.extra.Obj("P1a", Tessellate(b.get(), o.runs, 0.05, 20).ToJson());
        }
        {
            double op;
            // Same section mapping as the P3a result (circles split at the square's corner rays);
            // the unmapped skin is valid but twisted, see P3a.
            auto mapped = std::vector<std::vector<SmCurve*>>{ SplitCircle(0, 20, 45), Rect(40, 30, 30), SplitCircle(80, 10, 45) };
            BrepPtr b;
            try { b = Skin(mapped, 2, op); }
            catch (...) { for (auto& p : mapped) Free(p); throw; }
            for (auto& p : mapped) Free(p);
            r.extra.Obj("P3a", Tessellate(b.get(), o.runs, 0.05, 20).ToJson());
        }
        {
            SmBSplineCurve* h = Helix();
            SmCurve* prof = Circle(0, 0, 0, 2.0);
            SmTArray<SmCurve*> pr;
            pr.Add(prof);
            SmSweepOptions opt;
            opt.bCapEndsArg = TRUE;
            opt.bMoveProfileCenterToPath = TRUE;
            opt.bOrientProfilePerpendicularToPath = TRUE;
            SmBrep* res = nullptr;
            const long st = SmApiCreateCurveSweep(pr, h, nullptr, nullptr, &opt, res, nullptr, nullptr, nullptr);
            delete prof;
            delete h;
            Check(st, "SmApiCreateCurveSweep");
            BrepPtr b(res);
            r.extra.Obj("P4b", Tessellate(b.get(), o.runs, 0.05, 20).ToJson());
        }
        r.outcome = "pass";
    }
    catch (const KernelError& e)
    {
        r.outcome = "fail-clean";
        r.detail = e.what();
    }
    return r;
}
} // namespace

const std::vector<std::pair<std::string, CaseFn>>& AllCases()
{
    static const std::vector<std::pair<std::string, CaseFn>> cases = {
        { "P1a", P1a },
        { "P1b", P1b },
        { "P1b_smooth", P1b_smooth },
        { "P1c", P1c },
        { "P1d_r3", [](const RunOptions& o) { return P1d(o, 3.0, "P1d_r3"); } },
        { "P1d_r5", [](const RunOptions& o) { return P1d(o, 5.0, "P1d_r5"); } },
        { "P2a", P2a },
        { "P2b_ext1", [](const RunOptions& o) { return P2b(o, TRUE, "P2b_ext1"); } },
        { "P2b_ext0", [](const RunOptions& o) { return P2b(o, FALSE, "P2b_ext0"); } },
        { "P2c", P2c },
        { "P3a", P3a },
        { "P3b", P3b },
        { "P4a", P4a },
        { "P4b", [](const RunOptions& o) { return P4b(o, false); } },
        { "P4b_pipe", [](const RunOptions& o) { return P4b(o, true); } },
        { "E1", E1 },
        { "E2", E2 },
    };
    return cases;
}
} // namespace kt
