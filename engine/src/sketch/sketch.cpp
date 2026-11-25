#include "sketch/sketch.hpp"

namespace pc::sketch {

namespace {

template <class T>
const T* findById(const std::vector<T>& items, const std::string& id) {
    for (const auto& item : items)
        if (item.id == id) return &item;
    return nullptr;
}

} // namespace

const char* nameOf(ConstraintType t) {
    switch (t) {
    case ConstraintType::Coincident: return "coincident";
    case ConstraintType::Horizontal: return "horizontal";
    case ConstraintType::Vertical: return "vertical";
    case ConstraintType::Parallel: return "parallel";
    case ConstraintType::Perpendicular: return "perpendicular";
    case ConstraintType::Tangent: return "tangent";
    case ConstraintType::PointOnLine: return "pointOnLine";
    case ConstraintType::Distance: return "distance";
    case ConstraintType::LineAngle: return "lineAngle";
    case ConstraintType::Radius: return "radius";
    case ConstraintType::Diameter: return "diameter";
    }
    return "unknown";
}

bool hasValue(ConstraintType t) {
    return t == ConstraintType::Distance || t == ConstraintType::LineAngle || t == ConstraintType::Radius ||
           t == ConstraintType::Diameter;
}

const Point* Sketch::point(const std::string& id) const { return findById(points, id); }
const Line* Sketch::line(const std::string& id) const { return findById(lines, id); }
const Circle* Sketch::circle(const std::string& id) const { return findById(circles, id); }
const Arc* Sketch::arc(const std::string& id) const { return findById(arcs, id); }

} // namespace pc::sketch
