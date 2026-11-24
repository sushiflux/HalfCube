// Test parts P1 to P4 of PARTS.md, built with OCCT.
#pragma once

#include "json.hpp"

#include <TopoDS_Shape.hxx>

#include <functional>
#include <string>
#include <vector>

namespace kt {

// Result of building one case once.
struct CaseOut {
    bool done = false;       // the kernel reported success and returned a shape
    std::string error;       // kernel error text when !done
    TopoDS_Shape shape;      // final shape
    Json info = Json::object();  // case-specific facts (variant used, checks, statuses)
    double opMs = -1;        // time of the kernel operation itself (fillet, shell, loft, sweep)
};

// When false, cases build only their primary variant (used for the timed runs).
void setRunVariants(bool on);

struct CaseDef {
    std::string id;
    std::string description;
    std::function<CaseOut()> build;
    double expectedVolume = 0;  // analytic volume where it is exact, otherwise 0
};

std::vector<CaseDef> allCases();

// E1: face history of the hole cut and the fillet of P1a.
Json historyP1a();

} // namespace kt
