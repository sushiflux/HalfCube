// Closed regions of a solved sketch, found from its non-construction lines and circles.
//
// - Points joined by a driving coincident constraint count as one point (the first in list order names the group).
// - Lines form a graph over these points; loose ends and bridges (lines that bound no area on either side) are
//   dropped. The smallest closed loops are traced over half-edges: at every point the next edge clockwise from the
//   edge just walked, so bounded faces come out counter-clockwise.
// - A circle is a loop of its own. A connected group of lines (or a circle) lying inside a loop of another group
//   becomes a hole of the smallest such loop; its own loops are regions as well (a frame with a circle in it gives
//   the frame with a hole and the disc).
// - Curves that cross or touch without sharing a point are not supported yet: they are reported and left out.
// - Region key: the curve ids of the outer loop sorted (letter, then number) and joined by commas, then per hole
//   "|" and its sorted ids, holes sorted. It stays the same while only dimensions change.
#pragma once

#include "sketch/sketch.hpp"

#include <map>
#include <string>
#include <utility>
#include <vector>

namespace hc::model {

// One curve of a loop in the order it is walked. Lines run from point group `from` to `to`; a circle is alone in
// its loop and walked counter-clockwise (outer loop) or clockwise (hole).
struct LoopCurve {
    std::string id;
    bool circle = false;
    std::string from, to;  // point groups (lines only)
};

struct Loop {
    std::vector<LoopCurve> curves;  // outer loops counter-clockwise, holes clockwise (seen from the normal)
    double area = 0.0;              // mm^2, always positive
};

struct RegionInfo {
    std::string key;
    Loop outer;
    std::vector<Loop> holes;
    double area = 0.0;  // outer minus holes, mm^2

    std::vector<std::string> outerIds() const;
    std::vector<std::vector<std::string>> holeIds() const;
    // Number of curves of all loops (= side faces of an extrusion).
    std::size_t curveCount() const;
};

struct ProfileResult {
    std::vector<RegionInfo> regions;          // sorted by key
    std::vector<std::string> intersecting;    // curves left out because they cross or touch others
    std::vector<std::pair<std::string, std::string>> crossings;  // the pairs found, for the message
};

// Point group of every point id: the first point in list order of its group of driving coincident points.
std::map<std::string, std::string> pointGroups(const sketch::Sketch& s);

ProfileResult findRegions(const sketch::Sketch& solved);

// "l6" < "l10": letter prefix, then the number.
bool naturalLess(const std::string& a, const std::string& b);

} // namespace hc::model
