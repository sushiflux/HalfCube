#include "mesh.hpp"

#include "protocol.hpp"

#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRepGProp.hxx>
#include <BRepLib_ToolTriangulatedShape.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <IMeshTools_Parameters.hxx>
#include <Message_ProgressIndicator.hxx>
#include <NCollection_IndexedDataMap.hxx>
#include <NCollection_IndexedMap.hxx>
#include <NCollection_List.hxx>
#include <Poly_PolygonOnTriangulation.hxx>
#include <Poly_Triangulation.hxx>
#include <TopExp.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>

#include <bit>
#include <chrono>
#include <cstring>

static_assert(std::endian::native == std::endian::little, "the mesh encoding assumes a little-endian target");

namespace pc {

namespace {

using Clock = std::chrono::steady_clock;
double msSince(Clock::time_point t0) { return std::chrono::duration<double, std::milli>(Clock::now() - t0).count(); }

using ShapeMap = NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>;
using EdgeFaceMap = NCollection_IndexedDataMap<TopoDS_Shape, NCollection_List<TopoDS_Shape>, TopTools_ShapeMapHasher>;

class CancelIndicator : public Message_ProgressIndicator {
public:
    explicit CancelIndicator(const Model::CancelFn& fn) : fn_(fn) {}
    bool UserBreak() override { return fn_ && fn_(); }
    void Show(const Message_ProgressScope&, const bool) override {}

private:
    const Model::CancelFn& fn_;
};

const char* surfaceKind(const TopoDS_Face& f) {
    BRepAdaptor_Surface s(f, false);
    switch (s.GetType()) {
    case GeomAbs_Plane: return "plane";
    case GeomAbs_Cylinder: return "cylinder";
    case GeomAbs_Cone: return "cone";
    case GeomAbs_Sphere: return "sphere";
    case GeomAbs_Torus: return "torus";
    case GeomAbs_BezierSurface: return "bezier";
    case GeomAbs_BSplineSurface: return "bspline";
    case GeomAbs_SurfaceOfRevolution: return "revolution";
    case GeomAbs_SurfaceOfExtrusion: return "extrusion";
    case GeomAbs_OffsetSurface: return "offset";
    default: return "other";
    }
}

size_t alignUp(size_t n) {
    const size_t a = protocol::kPayloadAlignment;
    return (n + a - 1) / a * a;
}

Json vec3(double x, double y, double z) {
    Json a = Json::array();
    a.push(x); a.push(y); a.push(z);
    return a;
}

} // namespace

MeshBlock meshBody(const BodyOut& body, const MeshParams& p, const Model::CancelFn& cancelled) {
    MeshBlock out;
    const TopoDS_Shape& shape = body.shape;

    auto t0 = Clock::now();
    IMeshTools_Parameters mp;
    mp.Deflection = p.deflection;
    mp.Angle = p.angleDeg * 3.14159265358979323846 / 180.0;
    mp.Relative = false;
    mp.InParallel = false;
    occ::handle<CancelIndicator> ind = new CancelIndicator(cancelled);
    BRepMesh_IncrementalMesh mesher(shape, mp, ind->Start());
    if (cancelled && cancelled()) throw Cancelled{};
    out.meshMs = msSince(t0);

    t0 = Clock::now();
    std::vector<float> pos, nrm, edgePos;
    std::vector<uint32_t> idx, fid, edgeId;
    Json faces = Json::array();

    ShapeMap faceMap;
    TopExp::MapShapes(shape, TopAbs_FACE, faceMap);
    for (int i = 1; i <= faceMap.Extent(); ++i) {
        const TopoDS_Face face = TopoDS::Face(faceMap(i));
        const uint32_t triStart = static_cast<uint32_t>(fid.size());
        TopLoc_Location loc;
        const occ::handle<Poly_Triangulation>& tri = BRep_Tool::Triangulation(face, loc);
        if (!tri.IsNull()) {
            BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri);
            const bool hasLoc = !loc.IsIdentity();
            const gp_Trsf tr = loc.Transformation();
            const bool rev = face.Orientation() == TopAbs_REVERSED;
            const uint32_t base = static_cast<uint32_t>(pos.size() / 3);
            for (int k = 1; k <= tri->NbNodes(); ++k) {
                gp_Pnt pt = tri->Node(k);
                gp_Dir n = tri->Normal(k);
                if (hasLoc) { pt.Transform(tr); n.Transform(tr); }
                if (rev) n.Reverse();
                pos.push_back(float(pt.X())); pos.push_back(float(pt.Y())); pos.push_back(float(pt.Z()));
                nrm.push_back(float(n.X())); nrm.push_back(float(n.Y())); nrm.push_back(float(n.Z()));
            }
            for (int t = 1; t <= tri->NbTriangles(); ++t) {
                int a, b, c;
                tri->Triangle(t).Get(a, b, c);
                if (rev) std::swap(b, c);  // keep counter-clockwise winding seen from outside
                idx.push_back(base + uint32_t(a - 1));
                idx.push_back(base + uint32_t(b - 1));
                idx.push_back(base + uint32_t(c - 1));
                fid.push_back(uint32_t(i - 1));
            }
        }
        Json fi = Json::object();
        fi["faceId"] = i - 1;
        fi["surface"] = surfaceKind(face);
        const std::string* origin = body.origins.Seek(face);
        fi["originStep"] = origin ? *origin : body.lastStepId;
        fi["triangleStart"] = triStart;
        fi["triangleCount"] = static_cast<uint32_t>(fid.size()) - triStart;
        faces.push(fi);
    }

    // Visible B-rep edges as line segments, taken from the edge polygons on the face triangulations so they
    // match the shaded mesh exactly. Seam edges (closed surfaces) and degenerated edges are left out.
    EdgeFaceMap edgeFaces;
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);
    for (int j = 1; j <= edgeFaces.Extent(); ++j) {
        const TopoDS_Edge edge = TopoDS::Edge(edgeFaces.FindKey(j));
        if (BRep_Tool::Degenerated(edge)) continue;
        const auto& adj = edgeFaces(j);
        if (adj.IsEmpty()) continue;
        const TopoDS_Face face = TopoDS::Face(adj.First());
        if (BRep_Tool::IsClosed(edge, face)) continue;
        TopLoc_Location loc;
        const occ::handle<Poly_Triangulation>& tri = BRep_Tool::Triangulation(face, loc);
        if (tri.IsNull()) continue;
        const occ::handle<Poly_PolygonOnTriangulation>& poly = BRep_Tool::PolygonOnTriangulation(edge, tri, loc);
        if (poly.IsNull()) continue;
        const bool hasLoc = !loc.IsIdentity();
        const gp_Trsf tr = loc.Transformation();
        const auto& nodes = poly->Nodes();
        for (int k = nodes.Lower(); k < nodes.Upper(); ++k) {
            gp_Pnt a = tri->Node(nodes(k)), b = tri->Node(nodes(k + 1));
            if (hasLoc) { a.Transform(tr); b.Transform(tr); }
            for (const gp_Pnt& q : {a, b}) {
                edgePos.push_back(float(q.X())); edgePos.push_back(float(q.Y())); edgePos.push_back(float(q.Z()));
            }
            edgeId.push_back(uint32_t(j - 1));
        }
    }

    // Block layout: each buffer starts at an aligned offset.
    Json mesh = Json::object();
    mesh["vertexCount"] = static_cast<uint32_t>(pos.size() / 3);
    mesh["triangleCount"] = static_cast<uint32_t>(fid.size());
    mesh["edgeSegmentCount"] = static_cast<uint32_t>(edgeId.size());
    auto put = [&](const char* name, const void* data, size_t bytes) {
        const size_t off = alignUp(out.bytes.size());
        out.bytes.resize(off + bytes);
        if (bytes) std::memcpy(out.bytes.data() + off, data, bytes);
        Json ref = Json::object();
        ref["offset"] = static_cast<unsigned long long>(off);
        ref["byteLength"] = static_cast<unsigned long long>(bytes);
        mesh[name] = ref;
    };
    put("positions", pos.data(), pos.size() * sizeof(float));
    put("normals", nrm.data(), nrm.size() * sizeof(float));
    put("indices", idx.data(), idx.size() * sizeof(uint32_t));
    put("faceIds", fid.data(), fid.size() * sizeof(uint32_t));
    put("edgePositions", edgePos.data(), edgePos.size() * sizeof(float));
    put("edgeIds", edgeId.data(), edgeId.size() * sizeof(uint32_t));
    out.bytes.resize(alignUp(out.bytes.size()));

    GProp_GProps vp, sp;
    BRepGProp::VolumeProperties(shape, vp);
    BRepGProp::SurfaceProperties(shape, sp);
    Bnd_Box bb;
    BRepBndLib::AddOptimal(shape, bb, false, false);
    double x0, y0, z0, x1, y1, z1;
    bb.Get(x0, y0, z0, x1, y1, z1);

    Json info = Json::object();
    info["bodyId"] = body.bodyId;
    info["lastStepId"] = body.lastStepId;
    info["volume"] = vp.Mass();
    info["area"] = sp.Mass();
    Json box = Json::object();
    box["min"] = vec3(x0, y0, z0);
    box["max"] = vec3(x1, y1, z1);
    info["bbox"] = box;
    info["faceCount"] = faceMap.Extent();
    info["edgeCount"] = edgeFaces.Extent();
    info["faces"] = faces;
    info["mesh"] = mesh;
    out.info = info;
    out.encodeMs = msSince(t0);
    return out;
}

Json appendBlock(const MeshBlock& block, std::vector<uint8_t>& payload) {
    const size_t base = alignUp(payload.size());
    payload.resize(base);
    payload.insert(payload.end(), block.bytes.begin(), block.bytes.end());
    Json info = block.info;
    Json& mesh = info["mesh"];
    for (const char* name : {"positions", "normals", "indices", "faceIds", "edgePositions", "edgeIds"}) {
        Json& ref = mesh[name];
        ref["offset"] = static_cast<unsigned long long>(base + static_cast<size_t>(ref["offset"].number()));
    }
    return info;
}

} // namespace pc
