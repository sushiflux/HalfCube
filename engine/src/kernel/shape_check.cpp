#include "kernel/shape_check.hpp"

#include <BRepCheck.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_Result.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <NCollection_IndexedMap.hxx>
#include <TopExp.hxx>
#include <TopTools_ShapeMapHasher.hxx>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <sstream>

namespace pc::kernel {

namespace {

using ShapeMap = NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>;

int countShapes(const TopoDS_Shape& s, TopAbs_ShapeEnum type) {
    ShapeMap m;
    TopExp::MapShapes(s, type, m);
    return m.Extent();
}

const char* shapeTypeName(TopAbs_ShapeEnum t) {
    switch (t) {
    case TopAbs_VERTEX: return "vertex";
    case TopAbs_EDGE: return "edge";
    case TopAbs_WIRE: return "wire";
    case TopAbs_FACE: return "face";
    case TopAbs_SHELL: return "shell";
    case TopAbs_SOLID: return "solid";
    default: return "shape";
    }
}

std::string number(double v) {
    char buf[40];
    std::snprintf(buf, sizeof buf, "%.10g", v);
    return buf;
}

// BRepCheck findings: sub-shape type, index and status text, at most 20 entries.
std::string listFaults(const TopoDS_Shape& s, const BRepCheck_Analyzer& analyzer) {
    std::string out;
    int listed = 0;
    for (TopAbs_ShapeEnum t : {TopAbs_VERTEX, TopAbs_EDGE, TopAbs_WIRE, TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID}) {
        ShapeMap m;
        TopExp::MapShapes(s, t, m);
        for (int i = 1; i <= m.Extent() && listed < 20; ++i) {
            if (analyzer.IsValid(m(i))) continue;
            const auto& result = analyzer.Result(m(i));
            if (result.IsNull()) continue;
            std::ostringstream os;
            for (auto code : result->Status())
                if (code != BRepCheck_NoError) BRepCheck::Print(code, os);
            for (result->InitContextIterator(); result->MoreShapeInContext(); result->NextShapeInContext())
                for (auto code : result->StatusOnShape())
                    if (code != BRepCheck_NoError) BRepCheck::Print(code, os);
            std::string text = os.str();
            std::replace(text.begin(), text.end(), '\n', ' ');
            while (!text.empty() && text.back() == ' ') text.pop_back();
            if (text.empty()) continue;
            if (!out.empty()) out += "; ";
            out += std::string(shapeTypeName(t)) + " " + std::to_string(i) + ": " + text;
            ++listed;
        }
    }
    return out.empty() ? "BRepCheck_Analyzer reports the shape as invalid without naming a sub-shape" : out;
}

} // namespace

ShapeFacts inspectShape(const TopoDS_Shape& shape) {
    ShapeFacts f;
    if (shape.IsNull()) {
        f.faults = "the operation returned an empty shape";
        return f;
    }
    const BRepCheck_Analyzer analyzer(shape);
    f.valid = analyzer.IsValid();
    if (!f.valid) f.faults = listFaults(shape, analyzer);
    GProp_GProps props;
    BRepGProp::VolumeProperties(shape, props);
    f.volume = props.Mass();
    f.faceCount = countShapes(shape, TopAbs_FACE);
    f.solidCount = countShapes(shape, TopAbs_SOLID);
    return f;
}

std::string checkPlausible(const ShapeFacts& f, const Expectation& e, const std::string& op) {
    if (!f.valid) return op + ": the result is not a valid solid (" + f.faults + ").";
    if (f.solidCount != e.solidCount)
        return op + ": the result has " + std::to_string(f.solidCount) + " solids instead of " + std::to_string(e.solidCount) + ".";
    if (!std::isfinite(f.volume) || f.volume <= 0.0)
        return op + ": the result has the volume " + number(f.volume) + " mm^3; a solid needs a positive volume.";
    if (e.volume) {
        const double deviation = std::abs(f.volume - *e.volume) / std::abs(*e.volume);
        if (!(deviation <= e.relativeTolerance))
            return op + ": the volume is " + number(f.volume) + " mm^3 instead of " + number(*e.volume) + " mm^3 (relative deviation " +
                   number(deviation) + ", allowed " + number(e.relativeTolerance) + ").";
    }
    if (e.faceCount && f.faceCount != *e.faceCount)
        return op + ": the result has " + std::to_string(f.faceCount) + " faces instead of " + std::to_string(*e.faceCount) + ".";
    return {};
}

} // namespace pc::kernel
