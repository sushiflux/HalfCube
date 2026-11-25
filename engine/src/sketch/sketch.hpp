// Sketch data model of the engine: points, lines, circles and arcs referenced by id, plus constraints.
// Lines, circles and arcs refer to points by id; two elements that use the same point id are joined there.
#pragma once

#include <map>
#include <string>
#include <vector>

namespace pc::sketch {

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
};

struct Circle {
    std::string id;
    std::string center;
    double radius = 0.0;
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
    Distance,       // refs: point, point; value in mm
    LineAngle,      // refs: line; value = angle of p1 -> p2 against +x in rad
    Radius,         // refs: arc or circle; value in mm
    Diameter,       // refs: arc or circle; value in mm
};

const char* nameOf(ConstraintType t);

// driving = false makes a reference dimension: it is measured after solving and never given to the solver.
struct Constraint {
    std::string id;
    ConstraintType type = ConstraintType::Coincident;
    std::vector<std::string> refs;
    double value = 0.0;
    bool driving = true;
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
};

} // namespace pc::sketch
