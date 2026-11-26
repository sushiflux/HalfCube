// Sketch data model of the engine: points, lines, circles and arcs referenced by id, plus constraints.
// Lines, circles and arcs refer to points by id; two elements that use the same point id are joined there.
//
// Fixed references: every sketch has the origin point "@origin" (0, 0) and the axis lines "@axisU" and "@axisV"
// (from the origin along u and v). They are no elements of the lists, are never unknowns of the solver and can be
// referred to by constraints like any point or line.
#pragma once

#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace pc::sketch {

inline constexpr std::string_view kOrigin = "@origin";
inline constexpr std::string_view kAxisU = "@axisU";
inline constexpr std::string_view kAxisV = "@axisV";

// True for ids of the fixed references (they start with @).
inline bool isReserved(std::string_view id) { return !id.empty() && id.front() == '@'; }

struct Point {
    std::string id;
    double x = 0.0;
    double y = 0.0;
    bool fixed = false;  // a fixed point is no unknown of the solver
};

struct Line {
    std::string id;
    std::string p1;
    std::string p2;
    bool construction = false;  // construction lines belong to no profile
};

struct Circle {
    std::string id;
    std::string center;
    double radius = 0.0;
    bool construction = false;
};

// Counter-clockwise from start to end around center.
struct Arc {
    std::string id;
    std::string center;
    std::string start;
    std::string end;
    double radius = 0.0;
};

enum class ConstraintType {
    Coincident,     // refs: point, point
    Horizontal,     // refs: line
    Vertical,       // refs: line
    Parallel,       // refs: line, line
    Perpendicular,  // refs: line, line
    Tangent,        // refs: line, arc or circle
    PointOnLine,    // refs: point, line (infinite line through it)
    PointOnCircle,  // refs: point, circle
    EqualLength,    // refs: line, line
    EqualRadius,    // refs: circle, circle
    Fix,            // refs: point, line or circle; holds it at its current position (and radius)
    Distance,       // refs: point, point, or one line (its length); value in mm
    DistanceX,      // refs: point a, point b; b.x - a.x = value (mm)
    DistanceY,      // refs: point a, point b; b.y - a.y = value (mm)
    LineAngle,      // refs: line; value = angle of p1 -> p2 against +x in rad
    LineLineAngle,  // refs: line l1, line l2; counter-clockwise angle from l1 to l2 = value in rad
    Radius,         // refs: arc or circle; value in mm
    Diameter,       // refs: arc or circle; value in mm
    // Distances with what the user clicked: the perpendicular distance of a point (the centre of a
    // circle, when the centre was clicked) from a line, the shortest distance of the rim of a circle from a line, a point
    // or another circle. Values in mm, always positive; planegcs measures them with its own inside/outside rules.
    DistancePointLine,     // refs: point, line (infinite line)
    DistanceLineLine,      // refs: line, line: the start point of the first line from the second line (parallel lines: their distance)
    DistancePointCircle,   // refs: point, circle: |distance to the centre - radius|
    DistanceCircleLine,    // refs: circle, line: |distance of the centre from the line - radius|
    DistanceCircleCircle,  // refs: circle, circle: the gap between the rims (outside each other, or one inside the other)
};

const char* nameOf(ConstraintType t);

// driving = false makes a reference dimension: it is measured after solving and never given to the solver.
//
// LineLineAngle between rays: with `rays` set the angle is measured between a ray along each line, reversed (against the
// direction p1 -> p2) when reverse1 / reverse2 is set, counter-clockwise from the ray of refs[0] to the ray of refs[1]; value
// is that angle in rad, 0..pi. Without `rays` it is the counter-clockwise angle between the two line directions, any value.
struct Constraint {
    std::string id;
    ConstraintType type = ConstraintType::Coincident;
    std::vector<std::string> refs;
    double value = 0.0;
    bool driving = true;
    bool rays = false;
    bool reverse1 = false;
    bool reverse2 = false;
};

// True for the constraint types that carry a value (dimensions).
bool hasValue(ConstraintType t);

struct Sketch {
    std::vector<Point> points;
    std::vector<Line> lines;
    std::vector<Circle> circles;
    std::vector<Arc> arcs;
    std::vector<Constraint> constraints;

    const Point* point(const std::string& id) const;
    const Line* line(const std::string& id) const;
    const Circle* circle(const std::string& id) const;
    const Arc* arc(const std::string& id) const;

    // Points and lines including the fixed references (@origin; @axisU and @axisV as lines from the origin).
    bool isPoint(const std::string& id) const;
    bool isLine(const std::string& id) const;
};

} // namespace pc::sketch
