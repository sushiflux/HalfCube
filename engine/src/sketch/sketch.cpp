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
    case ConstraintType::PointOnCircle: return "pointOnCircle";
    case ConstraintType::EqualLength: return "equalLength";
    case ConstraintType::EqualRadius: return "equalRadius";
    case ConstraintType::Fix: return "fix";
    case ConstraintType::Distance: return "distance";
    case ConstraintType::DistanceX: return "distanceX";
    case ConstraintType::DistanceY: return "distanceY";
    case ConstraintType::LineAngle: return "lineAngle";
    case ConstraintType::LineLineAngle: return "angle";
    case ConstraintType::Radius: return "radius";
    case ConstraintType::Diameter: return "diameter";
    case ConstraintType::DistancePointLine: return "distancePointLine";
    case ConstraintType::DistanceLineLine: return "distanceLineLine";
    case ConstraintType::DistancePointCircle: return "distancePointCircle";
    case ConstraintType::DistanceCircleLine: return "distanceCircleLine";
    case ConstraintType::DistanceCircleCircle: return "distanceCircleCircle";
    }
    return "unknown";
}

bool hasValue(ConstraintType t) {
    switch (t) {
    case ConstraintType::Distance:
    case ConstraintType::DistanceX:
    case ConstraintType::DistanceY:
    case ConstraintType::LineAngle:
    case ConstraintType::LineLineAngle:
    case ConstraintType::Radius:
    case ConstraintType::Diameter:
    case ConstraintType::DistancePointLine:
    case ConstraintType::DistanceLineLine:
    case ConstraintType::DistancePointCircle:
    case ConstraintType::DistanceCircleLine:
    case ConstraintType::DistanceCircleCircle: return true;
    default: return false;
    }
}

const Point* Sketch::point(const std::string& id) const { return findById(points, id); }
const Line* Sketch::line(const std::string& id) const { return findById(lines, id); }
const Circle* Sketch::circle(const std::string& id) const { return findById(circles, id); }
const Arc* Sketch::arc(const std::string& id) const { return findById(arcs, id); }

bool Sketch::isPoint(const std::string& id) const { return id == kOrigin || point(id) != nullptr; }
bool Sketch::isLine(const std::string& id) const { return id == kAxisU || id == kAxisV || line(id) != nullptr; }

} // namespace pc::sketch
