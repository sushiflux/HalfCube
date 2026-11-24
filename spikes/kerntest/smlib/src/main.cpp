// Kernel test (SMLib track): command-line driver.
//   smlib_kerntest [--runs N] [--out DIR] [--json FILE] [--list] [CASE ...]
// Runs the selected cases (default: all) and writes one JSON document to FILE
// (default: smlib_kerntest.json). Kernel diagnostics may appear on stdout/stderr,
// which is why the results go to a file.
#include "kt.h"

#include <SmApiGeneral.h>
#include <SmConfig.h>
#include <SmTypes.h>

#include <cstdio>
#if defined(__EMSCRIPTEN__)
#include <emscripten/version.h>
#endif
#include <algorithm>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#ifndef KT_USD_BREP_VERSION
#define KT_USD_BREP_VERSION "unknown"
#endif
#ifndef KT_CXX_FLAGS
#define KT_CXX_FLAGS ""
#endif

static std::string Compiler()
{
    char b[128];
#if defined(__EMSCRIPTEN__)
    std::snprintf(b, sizeof b, "emscripten %d.%d.%d (clang %s)", __EMSCRIPTEN_major__, __EMSCRIPTEN_minor__, __EMSCRIPTEN_tiny__, __clang_version__);
#elif defined(_MSC_VER)
    std::snprintf(b, sizeof b, "MSVC %d (_MSC_FULL_VER %d)", _MSC_VER, _MSC_FULL_VER);
#elif defined(__GNUC__)
    std::snprintf(b, sizeof b, "GCC %s", __VERSION__);
#else
    std::snprintf(b, sizeof b, "unknown");
#endif
    return b;
}

static std::string Platform()
{
#if defined(__EMSCRIPTEN__)
    return "wasm32-emscripten";
#elif defined(_WIN32)
    return "windows-x86_64";
#elif defined(__linux__)
    return "linux-x86_64";
#else
    return "other";
#endif
}

int main(int argc, char** argv)
{
    kt::RunOptions opts;
    std::string jsonPath = "smlib_kerntest.json";
    std::vector<std::string> wanted;
    for (int i = 1; i < argc; ++i)
    {
        const std::string a = argv[i];
        if (a == "--runs" && i + 1 < argc) opts.runs = std::stoi(argv[++i]);
        else if (a == "--out" && i + 1 < argc) opts.outDir = argv[++i];
        else if (a == "--json" && i + 1 < argc) jsonPath = argv[++i];
        else if (a == "--list")
        {
            for (const auto& c : kt::AllCases()) std::cout << c.first << "\n";
            return 0;
        }
        else wanted.push_back(a);
    }

    SmApiCreateContext();
    kt::InstallErrorTrail();
    std::string cases = "[";
    bool first = true;
    for (const auto& c : kt::AllCases())
    {
        if (!wanted.empty() && std::find(wanted.begin(), wanted.end(), c.first) == wanted.end()) continue;
        std::cerr << "[kerntest] " << c.first << " ..." << std::endl;
        kt::CaseResult r;
        try
        {
            r = c.second(opts);
        }
        catch (const std::exception& e)
        {
            r.id = c.first;
            r.outcome = "fail-clean";
            r.detail = std::string("exception: ") + e.what();
        }
        std::cerr << "[kerntest] " << c.first << " -> " << r.outcome << std::endl;
        cases += (first ? "" : ",") + r.ToJson().Dump();
        first = false;
    }
    cases += "]";

    kt::Json doc;
    doc.Str("kernel", "NVIDIA USD BRep / SMLib").Str("usdBrepVersion", KT_USD_BREP_VERSION).Str("smlibVersionString", smos_FromTChar(SM_VERSION_STRING));
    doc.Str("platform", Platform()).Str("compiler", Compiler()).Str("cxxFlags", KT_CXX_FLAGS).Int("cplusplus", __cplusplus);
    doc.Int("runs", opts.runs).Raw("cases", cases);
    std::ofstream f(jsonPath, std::ios::binary);
    f << doc.Dump() << "\n";
    std::cerr << "[kerntest] wrote " << jsonPath << std::endl;
    return 0;
}
