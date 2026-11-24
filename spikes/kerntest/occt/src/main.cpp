// OCCT kernel test driver.
//
//   kerntest_occt run  [--runs N] [--cases P1a,P3a] [--out DIR] [--json FILE] [--skip-extras]
//   kerntest_occt p5b  --in FILE.step --out FILE.step [--json FILE]
//   kerntest_occt probe notdone|nullread|intdiv|nullcall [--json FILE]
//
// "run" builds the test parts of PARTS.md, times them (one warm-up run, then the median of N runs), measures
// and validates the results and, unless --skip-extras is given, runs P5a (STEP round trip), E1 (history) and
// E2 (meshing). "p5b" reads a foreign STEP file, cuts a D5 hole along Z through its bounding-box centre and
// writes the result back to STEP. "probe" shows how one kind of failure reaches the caller (see cmdProbe).

#include "json.hpp"
#include "kt_util.hpp"
#include "parts.hpp"

#include <BRepAlgoAPI_Cut.hxx>
#include <BRepBndLib.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepGProp.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <Geom_Line.hxx>
#include <OSD.hxx>
#include <Standard_ErrorHandler.hxx>
#include <Standard_Version.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <gp_Ax2.hxx>

#ifdef __EMSCRIPTEN__
#include <emscripten/version.h>  // __EMSCRIPTEN_MAJOR__ and friends
#endif

#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#ifndef KT_BUILD_FLAGS
#define KT_BUILD_FLAGS "unknown"
#endif
#ifndef KT_PLATFORM
#define KT_PLATFORM "unknown"
#endif

using namespace kt;

namespace {

std::string compilerString() {
    std::ostringstream os;
#if defined(__EMSCRIPTEN__)
    os << "emscripten " << __EMSCRIPTEN_MAJOR__ << "." << __EMSCRIPTEN_MINOR__ << "." << __EMSCRIPTEN_TINY__
       << " (clang " << __clang_version__ << ")";
#elif defined(_MSC_VER)
    os << "MSVC _MSC_FULL_VER=" << _MSC_FULL_VER;
#elif defined(__clang__)
    os << "clang " << __clang_version__;
#elif defined(__GNUC__)
    os << "GCC " << __VERSION__;
#endif
    os << ", __cplusplus=" << __cplusplus;
    return os.str();
}

Json environment() {
    Json e = Json::object();
    e["occt_version"] = OCC_VERSION_COMPLETE;
    e["compiler"] = compilerString();
    e["build_flags"] = KT_BUILD_FLAGS;
    e["platform"] = KT_PLATFORM;
#ifdef KT_WITH_STEP
    e["step"] = true;
#else
    e["step"] = false;
#endif
    return e;
}

std::string argValue(int argc, char** argv, const char* name, const std::string& def = "") {
    for (int i = 1; i + 1 < argc; ++i)
        if (std::strcmp(argv[i], name) == 0) return argv[i + 1];
    return def;
}
bool hasFlag(int argc, char** argv, const char* name) {
    for (int i = 1; i < argc; ++i)
        if (std::strcmp(argv[i], name) == 0) return true;
    return false;
}

void emit(const Json& j, const std::string& path) {
    const std::string text = j.dump(2) + "\n";
    if (path.empty()) {
        std::cout << text;
        return;
    }
    std::ofstream f(path, std::ios::binary);
    f << text;
    std::cerr << "wrote " << path << "\n";
}

int cmdRun(int argc, char** argv) {
    const int runs = std::stoi(argValue(argc, argv, "--runs", "5"));
    const std::string outDir = argValue(argc, argv, "--out", "kerntest-out");
    const std::string jsonPath = argValue(argc, argv, "--json");
    const bool extras = !hasFlag(argc, argv, "--skip-extras");
    std::set<std::string> only;
    {
        std::stringstream ss(argValue(argc, argv, "--cases"));
        std::string t;
        while (std::getline(ss, t, ',')) if (!t.empty()) only.insert(t);
    }
    std::filesystem::create_directories(outDir);

    Json root = Json::object();
    root["kernel"] = "OCCT";
    root["environment"] = environment();
    root["timing_rule"] = "wall clock, one warm-up run, median of " + std::to_string(runs) +
                          " runs of the primary variant; median_ms includes building the base solid, op_median_ms is the kernel operation alone";
    Json cases = Json::object();
    std::vector<std::pair<std::string, TopoDS_Shape>> results;

    for (const CaseDef& c : allCases()) {
        if (!only.empty() && !only.count(c.id)) continue;
        std::cerr << "case " << c.id << " ..." << std::flush;
        Json cj = Json::object();
        cj["description"] = c.description;
        std::vector<double> times, opTimes;
        CaseOut last;
        // Timed runs build only the primary variant; the other variants are built once afterwards.
        setRunVariants(false);
        for (int r = 0; r <= runs; ++r) {
            const auto t0 = Clock::now();
            try {
                OCC_CATCH_SIGNALS
                last = c.build();
            } catch (...) {
                last = CaseOut();
                last.error = describeCurrentException();
            }
            const double ms = msSince(t0);
            if (r > 0) {
                times.push_back(ms);
                if (last.opMs >= 0) opTimes.push_back(last.opMs);
            }
        }
        setRunVariants(true);
        CaseOut withVariants;
        try {
            OCC_CATCH_SIGNALS
            withVariants = c.build();
        } catch (...) {
            withVariants.error = describeCurrentException();
        }
        if (withVariants.info.type() == Json::Type::Object) {
            Json& ov = withVariants.info["other_variants"];
            if (ov.type() == Json::Type::Object) last.info["other_variants"] = ov;
        }
        cj["median_ms"] = median(times);
        if (!opTimes.empty()) cj["op_median_ms"] = median(opTimes);
        Json all = Json::array();
        for (double t : times) all.push(t);
        cj["runs_ms"] = all;
        cj["done"] = last.done;
        if (!last.error.empty()) cj["error"] = last.error;
        cj["details"] = last.info;
        std::string outcome = "fail-clean";
        if (last.done) {
            Json m = measure(last.shape);
            cj["measure"] = m;
            const bool valid = isValid(last.shape);
            outcome = valid ? "pass" : "invalid-result";
            if (c.expectedVolume > 0) {
                GProp_GProps p;
                BRepGProp::VolumeProperties(last.shape, p);
                const double rel = std::abs(p.Mass() - c.expectedVolume) / c.expectedVolume;
                cj["expected_volume_mm3"] = c.expectedVolume;
                cj["volume_rel_error_vs_expected"] = rel;
                if (rel > 1e-3) {
                    cj["volume_mismatch"] = true;
                    if (outcome == "pass") outcome = "invalid-result";
                }
            }
            cj["self_interference_check"] = selfInterference(last.shape);
            Json fl = Json::array();
            int nf = 0;
            for (TopExp_Explorer ex(last.shape, TopAbs_FACE); ex.More() && nf < 40; ex.Next(), ++nf)
                fl.push(describeFace(TopoDS::Face(ex.Current())));
            cj["face_list"] = fl;
            results.emplace_back(c.id, last.shape);
        }
        cj["outcome"] = outcome;
        cases[c.id] = cj;
        std::cerr << " " << outcome << " (" << median(times) << " ms)\n";
    }
    root["cases"] = cases;

    if (extras) {
#ifdef KT_WITH_STEP
        Json p5a = Json::object();
        for (const auto& [id, s] : results) {
            std::cerr << "P5a " << id << "\n";
            Json r = Json::object();
            r["AP214IS"] = stepRoundTrip(s, outDir + "/" + id + "_ap214.step", false);
            r["AP242DIS"] = stepRoundTrip(s, outDir + "/" + id + "_ap242.step", true);
            p5a[id] = r;
        }
        root["P5a"] = p5a;
#else
        root["P5a"] = "not built: STEP disabled in this build";
#endif
        if (only.empty() || only.count("P1a")) {
            std::cerr << "E1\n";
            try { OCC_CATCH_SIGNALS root["E1"] = historyP1a(); } catch (...) { root["E1"] = describeCurrentException(); }
        }
        Json e2 = Json::object();
        for (const auto& [id, s] : results) {
            // P1a, P3a, P4b are required by PARTS.md; P1d_r5 is meshed as an extra plausibility check.
            if (id != "P1a" && id != "P3a" && id != "P4b" && id != "P1d_r5") continue;
            std::cerr << "E2 " << id << "\n";
            try { OCC_CATCH_SIGNALS e2[id] = meshAndCheck(s, 0.05, 20.0, runs); } catch (...) { e2[id] = describeCurrentException(); }
        }
        root["E2"] = e2;
    }
    emit(root, jsonPath);
    return 0;
}

#ifdef KT_WITH_STEP
int cmdP5b(int argc, char** argv) {
    const std::string in = argValue(argc, argv, "--in");
    const std::string out = argValue(argc, argv, "--out");
    const std::string jsonPath = argValue(argc, argv, "--json");
    if (in.empty() || out.empty()) {
        std::cerr << "usage: kerntest_occt p5b --in FILE.step --out FILE.step [--json FILE]\n";
        return 2;
    }
    Json j = Json::object();
    j["kernel"] = "OCCT";
    j["environment"] = environment();
    j["input"] = std::filesystem::path(in).filename().string();
    try {
        OCC_CATCH_SIGNALS
        Json rinfo = Json::object();
        TopoDS_Shape s = readStep(in, &rinfo);
        j["read"] = rinfo;
        j["input_measure"] = measure(s);
        Bnd_Box box;
        BRepBndLib::AddOptimal(s, box, false, false);
        double x0, y0, z0, x1, y1, z1;
        box.Get(x0, y0, z0, x1, y1, z1);
        const double cx = 0.5 * (x0 + x1), cy = 0.5 * (y0 + y1);
        const double h = (z1 - z0) + 2.0;
        TopoDS_Shape tool = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(cx, cy, z0 - 1.0), gp_Dir(0, 0, 1)), 2.5, h).Shape();
        const auto t0 = Clock::now();
        BRepAlgoAPI_Cut cut(s, tool);
        j["cut_ms"] = msSince(t0);
        j["cut_done"] = cut.IsDone();
        if (cut.HasErrors()) {
            std::ostringstream os;
            cut.DumpErrors(os);
            j["cut_errors"] = os.str();
        }
        if (cut.HasWarnings()) {
            std::ostringstream os;
            cut.DumpWarnings(os);
            j["cut_warnings"] = os.str();
        }
        if (!cut.IsDone()) throw std::runtime_error("Boolean cut failed");
        const TopoDS_Shape res = cut.Shape();
        j["result_measure"] = measure(res);
        Json winfo = Json::object();
        writeStep(res, out, false, &winfo);
        j["write"] = winfo;
        j["output"] = std::filesystem::path(out).filename().string();
        // Round trip of the written file.
        Json binfo = Json::object();
        TopoDS_Shape back = readStep(out, &binfo);
        j["reread_measure"] = measure(back);
        j["ok"] = true;
    } catch (...) {
        j["ok"] = false;
        j["error"] = describeCurrentException();
    }
    emit(j, jsonPath);
    return 0;
}
#endif

// Error-reporting probes: how one failure of each kind reaches the caller on this platform. Each probe is meant to
// run in its own process, because the hardware-fault probes may end the process (or, in WebAssembly, the module).
//   notdone  - a fillet that cannot be built; Shape() then throws StdFail_NotDone (BRepLib_Command::Check)
//   nullread - reads through a null handle
//   intdiv   - integer division by zero
//   nullcall - calls through a null function pointer
volatile int gProbeZero = 0;
int (*volatile gProbeFn)(int) = nullptr;

int cmdProbe(int argc, char** argv) {
    const std::string which = argc > 2 ? argv[2] : "";
    Json j = Json::object();
    j["kernel"] = "OCCT";
    j["environment"] = environment();
    j["probe"] = which;
    try {
        OCC_CATCH_SIGNALS
        if (which == "notdone") {
            const TopoDS_Shape box = BRepPrimAPI_MakeBox(10, 10, 10).Shape();
            BRepFilletAPI_MakeFillet mk(box);
            TopExp_Explorer ex(box, TopAbs_EDGE);
            mk.Add(50.0, TopoDS::Edge(ex.Current()));
            mk.Build();
            j["is_done"] = mk.IsDone();
            j["nb_faulty_contours"] = mk.NbFaultyContours();
            const TopoDS_Shape s = mk.Shape();  // throws when not done
            j["result"] = "Shape() returned without exception";
        } else if (which == "nullread") {
            occ::handle<Geom_Line> line;
            const gp_Lin l = line->Lin();
            j["result"] = "read returned";
            j["value_read"] = l.Location().X();
        } else if (which == "intdiv") {
            const int q = 7 / gProbeZero;
            j["result"] = "division returned";
            j["value_read"] = q;
        } else if (which == "nullcall") {
            const int r = gProbeFn(1);
            j["result"] = "call returned";
            j["value_read"] = r;
        } else {
            std::cerr << "usage: kerntest_occt probe notdone|nullread|intdiv|nullcall [--json FILE]\n";
            return 2;
        }
        j["exception"] = false;
    } catch (...) {
        j["exception"] = true;
        j["error"] = describeCurrentException();
    }
    emit(j, argValue(argc, argv, "--json"));
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: kerntest_occt run|p5b [options]\n";
        return 2;
    }
    // Turn access violations and other signals inside OCCT into catchable exceptions (OSD.hxx).
    OSD::SetSignal(false);
    const std::string cmd = argv[1];
    if (cmd == "run") return cmdRun(argc, argv);
    if (cmd == "probe") return cmdProbe(argc, argv);
#ifdef KT_WITH_STEP
    if (cmd == "p5b") return cmdP5b(argc, argv);
#endif
    std::cerr << "unknown command: " << cmd << "\n";
    return 2;
}
