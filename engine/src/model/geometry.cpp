#include "model/geometry.hpp"

#include "core/errors.hpp"
#include "model/payload.hpp"

#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepGProp.hxx>
#include <BRepLib_ToolTriangulatedShape.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <NCollection_IndexedDataMap.hxx>
#include <NCollection_IndexedMap.hxx>
#include <NCollection_List.hxx>
#include <Poly_PolygonOnTriangulation.hxx>
#include <Poly_Triangulation.hxx>
#include <Standard_Failure.hxx>
#include <TopExp.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Ax2.hxx>
#include <gp_Ax3.hxx>
#include <gp_Circ.hxx>
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <map>
#include <numbers>
#include <tuple>

namespace pc::model {

namespace {

using Clock = std::chrono::steady_clock;
double msSince(Clock::time_point t0) { return std::chrono::duration<double, std::milli>(Clock::now() - t0).count(); }

using ShapeMap = NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>;
using AncestorMap = NCollection_IndexedDataMap<TopoDS_Shape, NCollection_List<TopoDS_Shape>, TopTools_ShapeMapHasher>;

gp_Pnt pnt(Vec3d v) { return gp_Pnt(v.x, v.y, v.z); }
gp_Dir dir(Vec3d v) { return gp_Dir(v.x, v.y, v.z); }

protocol::Problem problem(const char* code, const std::string& message, std::vector<std::string> refs = {}) {
    protocol::Problem p;
    p.code = code;
    p.message = message;
    if (!refs.empty()) p.refs = std::move(refs);
    return p;
}

std::string describeFailure() {
    try {
        throw;
    } catch (const Standard_Failure& e) {
        return std::string(e.ExceptionType()) + ": " + (e.what() && *e.what() ? e.what() : "(no message)");
    } catch (const std::exception& e) {
        return e.what();
    }
}

const char* surfaceKind(const TopoDS_Face& f) {
    const BRepAdaptor_Surface s(f, false);
    switch (s.GetType()) {
    case GeomAbs_Plane: return "plane";
    case GeomAbs_Cylinder: return "cylinder";
    case GeomAbs_Cone: return "cone";
    case GeomAbs_Sphere: return "sphere";
    case GeomAbs_Torus: return "torus";
    case GeomAbs_BSplineSurface: return "bspline";
    default: return "other";
    }
}

// Positions of the point groups of the solved sketch.
std::map<std::string, Vec3d> groupPositions(const sketch::Sketch& s, const Frame& frame) {
    std::map<std::string, Vec3d> out;
    for (const auto& p : s.points) out[p.id] = frame.at(p.x, p.y);
    return out;
}

} // namespace

ProfileFace buildProfileFace(const RegionInfo& region, const sketch::Sketch& solved, const Frame& frame) {
    ProfileFace pf;
    const auto positions = groupPositions(solved, frame);
    std::map<std::string, TopoDS_Vertex> vertex;
    const auto vertexOf = [&](const std::string& group) {
        auto it = vertex.find(group);
        if (it != vertex.end()) return it->second;
        const TopoDS_Vertex v = BRepBuilderAPI_MakeVertex(pnt(positions.at(group))).Vertex();
        vertex[group] = v;
        pf.vertices.emplace_back(group, v);
        return v;
    };
    const auto wireOf = [&](const Loop& loop, bool hole) {
        BRepBuilderAPI_MakeWire mw;
        for (const LoopCurve& c : loop.curves) {
            if (c.circle) {
                const sketch::Circle* ci = solved.circle(c.id);
                const sketch::Point* center = solved.point(ci->center);
                const gp_Circ circ(gp_Ax2(pnt(frame.at(center->x, center->y)), dir(frame.normal), dir(frame.u)), ci->radius);
                const TopoDS_Edge e = BRepBuilderAPI_MakeEdge(circ).Edge();
                TopoDS_Vertex first, last;
                TopExp::Vertices(e, first, last);
                pf.edges.emplace_back(c.id, e);
                pf.seams.emplace_back(c.id, first);
                // Circles run counter-clockwise around the normal; a hole runs the other way.
                mw.Add(hole ? TopoDS::Edge(e.Reversed()) : e);
            } else {
                // Two statements: the order of function arguments is unspecified, and the vertex order decides the
                // order of the names in the result (MSVC and clang differ).
                const TopoDS_Vertex from = vertexOf(c.from);
                const TopoDS_Vertex to = vertexOf(c.to);
                const TopoDS_Edge e = BRepBuilderAPI_MakeEdge(from, to).Edge();
                pf.edges.emplace_back(c.id, e);
                mw.Add(e);
            }
        }
        if (!mw.IsDone()) throw EngineError(protocol::err::kInternal, "The kernel could not join the curves of a region into a closed wire.");
        return mw.Wire();
    };
    const TopoDS_Wire outer = wireOf(region.outer, false);
    BRepBuilderAPI_MakeFace mf(gp_Pln(gp_Ax3(pnt(frame.origin), dir(frame.normal), dir(frame.u))), outer, true);
    for (const Loop& h : region.holes) mf.Add(wireOf(h, true));
    if (!mf.IsDone()) throw EngineError(protocol::err::kInternal, "The kernel could not build the planar face of region " + region.key + ".");
    pf.face = mf.Face();
    return pf;
}

RegionTriangles triangulateRegion(const RegionInfo& region, const sketch::Sketch& solved) {
    // On the xy frame the model coordinates are the sketch coordinates.
    const Frame flat{{0, 0, 0}, {1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
    const ProfileFace pf = buildProfileFace(region, solved, flat);
    BRepMesh_IncrementalMesh mesher(pf.face, kMeshDeflection, false, kMeshAngleDeg * std::numbers::pi / 180.0, false);
    RegionTriangles out;
    TopLoc_Location loc;
    const occ::handle<Poly_Triangulation>& tri = BRep_Tool::Triangulation(pf.face, loc);
    const gp_Trsf tr = loc.Transformation();
    if (!tri.IsNull()) {
        for (int k = 1; k <= tri->NbNodes(); ++k) {
            gp_Pnt p = tri->Node(k);
            if (!loc.IsIdentity()) p.Transform(tr);
            out.uv.push_back(static_cast<float>(p.X()));
            out.uv.push_back(static_cast<float>(p.Y()));
        }
        for (int t = 1; t <= tri->NbTriangles(); ++t) {
            int a = 0, b = 0, c = 0;
            tri->Triangle(t).Get(a, b, c);
            const auto ua = static_cast<std::size_t>(a - 1), ub = static_cast<std::size_t>(b - 1), uc = static_cast<std::size_t>(c - 1);
            const double area = (out.uv[2 * ub] - out.uv[2 * ua]) * (out.uv[2 * uc + 1] - out.uv[2 * ua + 1]) -
                                (out.uv[2 * uc] - out.uv[2 * ua]) * (out.uv[2 * ub + 1] - out.uv[2 * ua + 1]);
            // Counter-clockwise seen from the normal, whatever orientation the face has.
            out.indices.push_back(static_cast<std::uint32_t>(ua));
            out.indices.push_back(static_cast<std::uint32_t>(area >= 0 ? ub : uc));
            out.indices.push_back(static_cast<std::uint32_t>(area >= 0 ? uc : ub));
        }

    }

    // Outlines of the loops. Lines contribute their start point; a circle contributes the corner points the mesher
    // gave its edge, so the outline and the fill meet exactly.
    const auto outline = [&](const Loop& loop, bool hole) {
        std::vector<float> pts;
        const auto push = [&pts](double u, double v) {
            pts.push_back(static_cast<float>(u));
            pts.push_back(static_cast<float>(v));
        };
        for (const LoopCurve& c : loop.curves) {
            if (!c.circle) {
                const sketch::Point* p = solved.point(c.from);
                push(p->x, p->y);
                continue;
            }
            std::vector<float> ring;
            for (const auto& [id, edge] : pf.edges) {
                if (id != c.id) continue;
                if (tri.IsNull()) break;
                const occ::handle<Poly_PolygonOnTriangulation>& poly = BRep_Tool::PolygonOnTriangulation(edge, tri, loc);
                if (poly.IsNull()) break;
                const auto& nodes = poly->Nodes();
                for (int j = nodes.Lower(); j <= nodes.Upper(); ++j) {
                    gp_Pnt pt = tri->Node(nodes(j));
                    if (!loc.IsIdentity()) pt.Transform(tr);
                    ring.push_back(static_cast<float>(pt.X()));
                    ring.push_back(static_cast<float>(pt.Y()));
                }
                // A closed edge repeats its first node at the end.
                if (ring.size() >= 4 && ring[0] == ring[ring.size() - 2] && ring[1] == ring[ring.size() - 1]) ring.resize(ring.size() - 2);
                break;
            }
            if (ring.size() < 6) {
                // The mesher left no polygon on this edge: cut the circle with the same chord deviation and angle.
                const sketch::Circle* ci = solved.circle(c.id);
                const sketch::Point* m = solved.point(ci->center);
                const double step = std::min(2.0 * std::acos(std::max(0.0, 1.0 - kMeshDeflection / ci->radius)), kMeshAngleDeg * std::numbers::pi / 180.0);
                const int n = std::max(8, static_cast<int>(std::ceil(2.0 * std::numbers::pi / step)));
                ring.clear();
                for (int j = 0; j < n; ++j) {
                    const double a = 2.0 * std::numbers::pi * j / n;
                    ring.push_back(static_cast<float>(m->x + ci->radius * std::cos(a)));
                    ring.push_back(static_cast<float>(m->y + ci->radius * std::sin(a)));
                }
            }
            // The nodes run counter-clockwise (along the circle); a hole runs clockwise.
            if (hole)
                for (std::size_t j = ring.size() / 2; j-- > 0;) push(ring[2 * j], ring[2 * j + 1]);
            else
                pts.insert(pts.end(), ring.begin(), ring.end());
        }
        return pts;
    };
    out.loops.push_back(outline(region.outer, false));
    for (const Loop& h : region.holes) out.loops.push_back(outline(h, true));
    return out;
}

ExtrudeOutcome extrudeRegion(const RegionInfo& region, const sketch::Sketch& solved, const Frame& frame, const ExtrudeParams& p) {
    ExtrudeOutcome out;
    const std::string& f = p.featureId;
    if (p.distance == 0.0) {
        out.problem = problem(protocol::problem::kExtrudeZeroDistance, "Extrusion " + f + ": the distance is 0 mm; an extrusion needs a length.");
        return out;
    }
    const bool symmetric = p.extent == "symmetric";
    // symmetric: the distance is the total thickness, half of it on each side of the sketch plane. The profile is
    // built directly on the plane moved to the -n side, so no extra move operation with its own history exists.
    const double thickness = std::abs(p.distance);
    const Frame base = symmetric ? frame.offset(-thickness / 2.0) : frame;
    const Vec3d along = symmetric ? frame.normal * thickness : frame.normal * p.distance;

    try {
        const ProfileFace pf = buildProfileFace(region, solved, base);
        const kernel::ShapeFacts faceFacts = kernel::inspectShape(pf.face);
        if (!faceFacts.valid) {
            out.problem = problem(protocol::problem::kResultInvalid, "Extrusion " + f + ": the profile face of region " + region.key +
                                                                         " is not valid (" + faceFacts.faults + ").",
                                  {region.key});
            return out;
        }
        BRepPrimAPI_MakePrism prism(pf.face, gp_Vec(along.x, along.y, along.z), false, true);
        if (!prism.IsDone()) {
            out.problem = problem(protocol::problem::kKernelFailed, "Extrusion " + f + ": the kernel did not build the prism.");
            return out;
        }
        BodyShape body;
        body.shape = prism.Shape();
        body.history.step = f;

        // Names, in a fixed order: caps, then per curve its side face and the cap edges, per point the lateral edge.
        body.faces.push_back({f + ":start", prism.FirstShape()});
        body.faces.push_back({f + ":end", prism.LastShape()});
        OpHistory::Entry profileEntry{"profile", "generated", {f + ":start", f + ":end"}};
        for (const auto& [id, edge] : pf.edges) {
            const NCollection_List<TopoDS_Shape>& gen = prism.Generated(edge);
            if (gen.Extent() != 1)
                throw EngineError(protocol::err::kInternal, "Extrusion " + f + ": the kernel generated " + std::to_string(gen.Extent()) +
                                                                " faces from the edge of " + id + " instead of one.");
            body.faces.push_back({f + ":side:" + id, gen.First()});
            body.edges.push_back({f + ":start:" + id, prism.FirstShape(edge)});
            body.edges.push_back({f + ":end:" + id, prism.LastShape(edge)});
            body.history.entries.push_back({id, "generated", {f + ":side:" + id, f + ":start:" + id, f + ":end:" + id}});
        }
        const auto vertexNames = [&](const std::string& role, const std::string& id, const TopoDS_Vertex& v) {
            const NCollection_List<TopoDS_Shape>& gen = prism.Generated(v);
            if (gen.Extent() != 1)
                throw EngineError(protocol::err::kInternal, "Extrusion " + f + ": the kernel generated " + std::to_string(gen.Extent()) +
                                                                " edges from the vertex of " + id + " instead of one.");
            const std::string tail = role.empty() ? id : role + ":" + id;
            body.edges.push_back({f + ":" + (role.empty() ? "lateral" : role) + ":" + id, gen.First()});
            body.vertices.push_back({f + ":start:" + tail, prism.FirstShape(v)});
            body.vertices.push_back({f + ":end:" + tail, prism.LastShape(v)});
            body.history.entries.push_back({id, "generated", {body.edges.back().name}});
        };
        for (const auto& [group, v] : pf.vertices) vertexNames("", group, v);
        for (const auto& [circle, v] : pf.seams) vertexNames("seam", circle, v);
        body.history.entries.insert(body.history.entries.begin(), profileEntry);

        // Every face, edge and vertex of the result must carry exactly one name, and every name hit exactly one part.
        for (const auto& [kind, list, what] : {std::tuple{TopAbs_FACE, &body.faces, "face"}, std::tuple{TopAbs_EDGE, &body.edges, "edge"},
                                               std::tuple{TopAbs_VERTEX, &body.vertices, "vertex"}}) {
            ShapeMap all;
            TopExp::MapShapes(body.shape, kind, all);
            std::vector<int> hits(static_cast<std::size_t>(all.Extent()), 0);
            for (const Named& n : *list) {
                const int index = all.FindIndex(n.shape);
                if (index <= 0)
                    throw EngineError(protocol::err::kInternal, "Extrusion " + f + ": the name " + n.name + " points at no " + what + " of the result.");
                ++hits[static_cast<std::size_t>(index - 1)];
            }
            for (std::size_t i = 0; i < hits.size(); ++i)
                if (hits[i] != 1)
                    throw EngineError(protocol::err::kInternal, "Extrusion " + f + ": " + what + " " + std::to_string(i + 1) + " of the result has " +
                                                                    std::to_string(hits[i]) + " names instead of one.");
        }

        const kernel::ShapeFacts facts = kernel::inspectShape(body.shape);
        kernel::Expectation expect;
        expect.volume = region.area * thickness;
        expect.faceCount = static_cast<int>(region.curveCount() + 2);
        protocol::StepCheck check;
        check.valid = facts.valid;
        check.volume = facts.volume;
        check.expectedVolume = *expect.volume;
        check.faces = facts.faceCount;
        check.expectedFaces = *expect.faceCount;
        check.solids = facts.solidCount;
        out.check = check;
        const std::string implausible = kernel::checkPlausible(facts, expect, "Extrusion " + f);
        if (!implausible.empty()) {
            auto pr = problem(facts.valid ? protocol::problem::kResultImplausible : protocol::problem::kResultInvalid, implausible);
            pr.values = std::map<std::string, double>{{"volume", facts.volume},
                                                       {"expectedVolume", *expect.volume},
                                                       {"faces", static_cast<double>(facts.faceCount)},
                                                       {"expectedFaces", static_cast<double>(*expect.faceCount)},
                                                       {"solids", static_cast<double>(facts.solidCount)}};
            out.problem = pr;
            return out;
        }
        out.body = std::move(body);
    } catch (const EngineError&) {
        throw;
    } catch (const Standard_Failure&) {
        out.problem = problem(protocol::problem::kKernelFailed, "Extrusion " + f + ": the kernel failed (" + describeFailure() + ").");
    }
    return out;
}

MeshedBody meshBody(const BodyShape& body, const std::string& bodyId, const std::string& featureId, const std::string& meshKey) {
    MeshedBody out;
    auto t0 = Clock::now();
    BRepMesh_IncrementalMesh mesher(body.shape, kMeshDeflection, false, kMeshAngleDeg * std::numbers::pi / 180.0, false);
    out.meshMs = msSince(t0);
    t0 = Clock::now();

    std::vector<float> pos, nrm, edgePts;
    std::vector<std::uint32_t> idx, triFace;
    protocol::BodyResult& info = out.info;
    // The named faces come from the prism builder; their orientation inside the solid (which decides which side is
    // outside) is the one the solid itself has.
    ShapeMap solidFaces;
    TopExp::MapShapes(body.shape, TopAbs_FACE, solidFaces);
    for (const Named& n : body.faces) {
        const TopoDS_Face face = TopoDS::Face(solidFaces.FindKey(solidFaces.FindIndex(n.shape)));
        protocol::BodyFace bf;
        bf.name = n.name;
        bf.surface = surfaceKind(face);
        bf.triangleStart = static_cast<std::int64_t>(triFace.size());
        TopLoc_Location loc;
        const occ::handle<Poly_Triangulation>& tri = BRep_Tool::Triangulation(face, loc);
        if (!tri.IsNull()) {
            BRepLib_ToolTriangulatedShape::ComputeNormals(face, tri);
            const gp_Trsf tr = loc.Transformation();
            const bool rev = face.Orientation() == TopAbs_REVERSED;
            const auto base = static_cast<std::uint32_t>(pos.size() / 3);
            for (int k = 1; k <= tri->NbNodes(); ++k) {
                gp_Pnt pt = tri->Node(k);
                gp_Dir nd = tri->Normal(k);
                if (!loc.IsIdentity()) {
                    pt.Transform(tr);
                    nd.Transform(tr);
                }
                if (rev) nd.Reverse();
                for (double c : {pt.X(), pt.Y(), pt.Z()}) pos.push_back(static_cast<float>(c));
                for (double c : {nd.X(), nd.Y(), nd.Z()}) nrm.push_back(static_cast<float>(c));
            }
            const auto faceIndex = static_cast<std::uint32_t>(info.faces.size());
            for (int t = 1; t <= tri->NbTriangles(); ++t) {
                int a = 0, b = 0, c = 0;
                tri->Triangle(t).Get(a, b, c);
                if (rev) std::swap(b, c);  // counter-clockwise seen from outside
                idx.push_back(base + static_cast<std::uint32_t>(a - 1));
                idx.push_back(base + static_cast<std::uint32_t>(b - 1));
                idx.push_back(base + static_cast<std::uint32_t>(c - 1));
                triFace.push_back(faceIndex);
            }
        }
        bf.triangleCount = static_cast<std::int64_t>(triFace.size()) - bf.triangleStart;
        info.faces.push_back(bf);
    }

    // Visible edges as polylines from the edge polygons on a face triangulation, so they match the shaded mesh.
    // Seams (the closed edge of a cylinder) are left out.
    AncestorMap edgeFaces;
    TopExp::MapShapesAndAncestors(body.shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);
    for (const Named& n : body.edges) {
        const TopoDS_Edge edge = TopoDS::Edge(n.shape);
        if (BRep_Tool::Degenerated(edge)) continue;
        const int k = edgeFaces.FindIndex(edge);
        if (k <= 0 || edgeFaces(k).IsEmpty()) continue;
        const TopoDS_Face face = TopoDS::Face(edgeFaces(k).First());
        if (BRep_Tool::IsClosed(edge, face)) continue;
        TopLoc_Location loc;
        const occ::handle<Poly_Triangulation>& tri = BRep_Tool::Triangulation(face, loc);
        if (tri.IsNull()) continue;
        const occ::handle<Poly_PolygonOnTriangulation>& poly = BRep_Tool::PolygonOnTriangulation(edge, tri, loc);
        if (poly.IsNull()) continue;
        const gp_Trsf tr = loc.Transformation();
        protocol::BodyEdge be;
        be.name = n.name;
        be.pointStart = static_cast<std::int64_t>(edgePts.size() / 3);
        const auto& nodes = poly->Nodes();
        for (int j = nodes.Lower(); j <= nodes.Upper(); ++j) {
            gp_Pnt pt = tri->Node(nodes(j));
            if (!loc.IsIdentity()) pt.Transform(tr);
            for (double c : {pt.X(), pt.Y(), pt.Z()}) edgePts.push_back(static_cast<float>(c));
        }
        be.pointCount = static_cast<std::int64_t>(edgePts.size() / 3) - be.pointStart;
        info.edges.push_back(be);
    }

    PayloadWriter w;
    info.mesh.vertexCount = static_cast<std::int64_t>(pos.size() / 3);
    info.mesh.triangleCount = static_cast<std::int64_t>(triFace.size());
    info.mesh.edgePointCount = static_cast<std::int64_t>(edgePts.size() / 3);
    info.mesh.positions = w.add(pos);
    info.mesh.normals = w.add(nrm);
    info.mesh.indices = w.add(idx);
    info.mesh.triangleFace = w.add(triFace);
    info.mesh.edgePoints = w.add(edgePts);
    out.block = std::move(w.bytes());

    GProp_GProps vp, sp;
    BRepGProp::VolumeProperties(body.shape, vp);
    BRepGProp::SurfaceProperties(body.shape, sp);
    Bnd_Box bb;
    BRepBndLib::AddOptimal(body.shape, bb, false, false);
    double x0 = 0, y0 = 0, z0 = 0, x1 = 0, y1 = 0, z1 = 0;
    bb.Get(x0, y0, z0, x1, y1, z1);
    info.bodyId = bodyId;
    info.featureId = featureId;
    info.meshKey = meshKey;
    info.preview = false;
    info.volume = vp.Mass();
    info.area = sp.Mass();
    info.bbox.min.x = x0;
    info.bbox.min.y = y0;
    info.bbox.min.z = z0;
    info.bbox.max.x = x1;
    info.bbox.max.y = y1;
    info.bbox.max.z = z1;
    out.encodeMs = msSince(t0);
    return out;
}

} // namespace pc::model
