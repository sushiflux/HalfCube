// Kernel test (SMLib track): shared types and helpers.
#pragma once

#include <chrono>
#include <functional>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

class SmBrep;
class SmFace;
class SmEdge;

namespace kt
{
using Clock = std::chrono::steady_clock;

inline double MsSince(Clock::time_point t0)
{
    return std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
}

// A kernel call that did not return SM_SUCCESS.
struct KernelError : std::runtime_error
{
    long status;
    std::string op;
    KernelError(long s, const std::string& o, const std::string& msg) : std::runtime_error(msg), status(s), op(o) {}
};

// Kernel error trail: messages the kernel reports through smos_SetErrorCallback.
void InstallErrorTrail();
std::string TakeErrorTrail();

// Throws KernelError when status is not SM_SUCCESS.
void Check(long status, const char* op);
const char* StatusName(long status);

// Minimal ordered JSON object builder (values are pre-serialised JSON text).
class Json
{
public:
    Json& Num(const std::string& k, double v);
    Json& Int(const std::string& k, long long v);
    Json& Str(const std::string& k, const std::string& v);
    Json& Bool(const std::string& k, bool v);
    Json& Raw(const std::string& k, const std::string& json);
    Json& Obj(const std::string& k, const Json& o) { return Raw(k, o.Dump()); }
    Json& NumArr(const std::string& k, const std::vector<double>& v);
    Json& StrArr(const std::string& k, const std::vector<std::string>& v);
    std::string Dump() const;
    bool Empty() const { return m_items.empty(); }

private:
    std::vector<std::pair<std::string, std::string>> m_items;
};
std::string Quote(const std::string& s);
std::string Fmt(double v); // 4 significant digits are applied in the report, raw values are kept here

// Kernel-reported properties of a Brep plus the validity checks.
struct Metrics
{
    bool haveBrep = false;
    double volume = 0, area = 0;
    unsigned long faces = 0, edges = 0, vertices = 0;
    double bbMin[3] = { 0, 0, 0 }, bbMax[3] = { 0, 0, 0 };
    bool manifoldSolid = false;
    long solidRegions = -1, voidRegions = -1;
    bool assertValidL0 = false, assertValidL2 = false;
    unsigned long reportsL2 = 0;
    std::vector<std::string> firstReports;
    std::string queryError; // a property query that failed
    Json ToJson() const;
};
Metrics Measure(SmBrep* brep);

// Result of one test case.
struct CaseResult
{
    std::string id;
    std::string outcome = "not-run"; // pass | fail-clean | invalid-result | not-supported | not-run
    std::string detail;
    std::vector<double> opMs, totalMs; // timed runs (after warm-up)
    Metrics metrics;
    Json extra;
    Json ToJson() const;
};

double Median(std::vector<double> v);

// Owning wrapper for a Brep produced by SM_API.
struct BrepPtr
{
    SmBrep* p = nullptr;
    BrepPtr() = default;
    explicit BrepPtr(SmBrep* b) : p(b) {}
    BrepPtr(const BrepPtr&) = delete;
    BrepPtr& operator=(const BrepPtr&) = delete;
    BrepPtr(BrepPtr&& o) noexcept : p(o.p) { o.p = nullptr; }
    BrepPtr& operator=(BrepPtr&& o) noexcept;
    ~BrepPtr();
    SmBrep* get() const { return p; }
    SmBrep* release() { SmBrep* r = p; p = nullptr; return r; }
    void reset(SmBrep* b = nullptr);
};

// Geometry selection helpers (all by the kernel's own bounding boxes).
std::vector<SmEdge*> EdgesInBox(SmBrep* b, const double lo[3], const double hi[3]);
std::vector<SmFace*> FacesInBox(SmBrep* b, const double lo[3], const double hi[3]);
std::vector<SmEdge*> AllEdges(SmBrep* b);
std::vector<SmFace*> AllFaces(SmBrep* b);

// Test-case registry
struct RunOptions
{
    int runs = 5;              // timed runs after one warm-up
    std::string outDir;        // where native/mesh artefacts go (may be empty)
};
using CaseFn = std::function<CaseResult(const RunOptions&)>;
const std::vector<std::pair<std::string, CaseFn>>& AllCases();

// Tessellation statistics (E2).
struct MeshStats
{
    bool ok = false;
    std::string error;
    unsigned long triangles = 0, polyFaces = 0, points = 0;
    unsigned long laminaEdges = 0, spineEdges = 0;
    bool outputManifold = false, inputManifold = false;
    double meshVolume = 0;
    std::vector<double> ms;
    Json ToJson() const;
};
MeshStats Tessellate(SmBrep* b, int runs, double chord, double angleDeg);

} // namespace kt
