#include "model/model.hpp"

#include "model/payload.hpp"
#include "sketch/sketch_freedom.hpp"

#include <algorithm>
#include <cmath>
#include <chrono>
#include <cstdio>
#include <map>
#include <numbers>
#include <set>
#include <variant>

namespace hc::model {

namespace {

using Clock = std::chrono::steady_clock;
double msSince(Clock::time_point t0) { return std::chrono::duration<double, std::milli>(Clock::now() - t0).count(); }

std::string joined(const std::vector<std::string>& ids) {
    std::string s;
    for (const auto& id : ids) s += (s.empty() ? "" : ", ") + id;
    return s;
}

std::string exact(double v) {
    char buf[40];
    std::snprintf(buf, sizeof buf, "%.17g", v);
    return buf;
}

// Start value of the mesh key hash. The mesh key must stay stable: the UI keeps an unchanged mesh when the key is equal,
// and keys that are stored with a geometry cache (planned in the project file) are only valid for the value they were
// computed with. Changing it changes every mesh key; do it only together with a new key generation.
constexpr std::uint64_t kMeshKeyBasis = 1469598103934665603ull;
constexpr std::uint64_t kMeshKeyPrime = 1099511628211ull;

// FNV-1a, 64 bit, as 16 hex digits: a short, stable mesh key.
std::string shortHash(const std::string& s) {
    std::uint64_t h = kMeshKeyBasis;
    for (const char ch : s) {
        h ^= static_cast<unsigned char>(ch);
        h *= kMeshKeyPrime;
    }
    char buf[17];
    std::snprintf(buf, sizeof buf, "%016llx", static_cast<unsigned long long>(h));
    return buf;
}

protocol::Problem makeProblem(const char* code, const std::string& message, std::vector<std::string> refs = {}) {
    protocol::Problem p;
    p.code = code;
    p.message = message;
    if (!refs.empty()) p.refs = std::move(refs);
    return p;
}

// Why a sketch was not solved, or nothing when it was.
std::optional<protocol::Problem> solveProblem(const sketch::SolveResult& r) {
    switch (r.status) {
    case sketch::SolveStatus::Solved: return std::nullopt;
    case sketch::SolveStatus::Conflicting:
        return makeProblem(protocol::problem::kSketchConflicting,
                           "Constraints of the sketch contradict each other, among them: " + joined(r.conflicting) + ". The sketch was not solved.",
                           r.conflicting);
    case sketch::SolveStatus::Redundant:
        return makeProblem(protocol::problem::kSketchRedundant,
                           "Constraints of the sketch repeat what others already fix, among them: " + joined(r.redundant) + ". The sketch was not solved.",
                           r.redundant);
    case sketch::SolveStatus::Failed:
        return makeProblem(protocol::problem::kSketchUnsolvable,
                           "The sketch cannot be solved with these constraints and dimensions; the solver found no solution and named no constraint.");
    }
    return std::nullopt;
}

std::optional<protocol::Problem> intersectProblem(const ProfileResult& p) {
    if (p.intersecting.empty()) return std::nullopt;
    std::string pairs;
    for (const auto& [a, b] : p.crossings) pairs += (pairs.empty() ? "" : ", ") + a + " / " + b;
    return makeProblem(protocol::problem::kProfileIntersecting,
                       "Curves of the sketch cross or touch without sharing a point (" + pairs +
                           "); closed regions are only found among the other curves.",
                       p.intersecting);
}

// Reference dimensions as the user reads them: angles in degrees.
double reportedValue(const sketch::Sketch& s, const std::string& id, double value) {
    for (const auto& c : s.constraints) {
        if (c.id != id) continue;
        // Between two rays the angle is shown without a sign, 0 to 180 degrees, whichever way the lines have turned.
        if (c.type == sketch::ConstraintType::LineLineAngle && c.rays) return std::abs(value) * 180.0 / std::numbers::pi;
        if (c.type == sketch::ConstraintType::LineLineAngle || c.type == sketch::ConstraintType::LineAngle) return value * 180.0 / std::numbers::pi;
    }
    return value;
}

} // namespace

sketch::SolveResult solveAt(const sketch::Sketch& s, const std::string& path, const sketch::SolveOptions& options) {
    try {
        return sketch::solve(s, options);
    } catch (const sketch::SketchError& e) {
        throw EngineError(protocol::err::kBadDocument, path + ": " + e.what());
    }
}

Answer<protocol::SketchSolveResult> solveSketch(const protocol::SketchSolveCommand& command, const CancelCheck& cancelled) {
    const auto t0 = Clock::now();
    throwIfCancelled(cancelled, "Command \"sketch.solve\"");
    const sketch::Sketch input = toSketch(command.sketch, "sketch");
    sketch::SolveOptions options;
    options.diagnose = command.diagnose;
    if (command.drag) {
        const auto& points = command.drag->points;
        if (points.empty()) throw EngineError(protocol::err::kBadMessage, "The field \"drag.points\" must name at least one point to drag.");
        for (std::size_t i = 0; i < points.size(); ++i) {
            const std::string where = "drag.points[" + std::to_string(i) + "]";
            if (!input.point(points[i].id))
                throw EngineError(protocol::err::kBadMessage, "The field \"" + where + ".id\" names \"" + points[i].id + "\", which is no point of the sketch.");
            for (std::size_t j = 0; j < i; ++j)
                if (points[j].id == points[i].id)
                    throw EngineError(protocol::err::kBadMessage, "The field \"" + where + ".id\" names \"" + points[i].id + "\" again; a point is dragged to one target only.");
            options.drag.push_back({points[i].id, points[i].x, points[i].y});
        }
    }
    const sketch::SolveResult r = solveAt(input, "sketch", options);

    Answer<protocol::SketchSolveResult> out;
    protocol::SketchSolveResult& m = out.message;
    m.status = sketch::nameOf(r.status);
    m.dof = r.dof;
    for (const auto& p : r.geometry.points) {
        protocol::SolvedPoint sp;
        sp.id = p.id;
        sp.x = p.x;
        sp.y = p.y;
        m.points.push_back(sp);
    }
    for (const auto& c : r.geometry.circles) {
        protocol::SolvedCircle sc;
        sc.id = c.id;
        sc.radius = c.radius;
        m.circles.push_back(sc);
    }
    if (command.diagnose && r.diagnosed) {
        for (const auto& [id, state] : sketch::entityStates(r.geometry, r)) m.entities[id] = sketch::nameOf(state);
        for (const auto& c : r.geometry.constraints) m.constraints[c.id] = "ok";
        for (const auto& id : r.partiallyRedundant) m.constraints[id] = "partiallyRedundant";
        for (const auto& id : r.redundant) m.constraints[id] = "redundant";
        for (const auto& id : r.conflicting) m.constraints[id] = "conflicting";
    }
    // What is still free, in facts (the palette lists them); not while dragging, where only the geometry is wanted.
    if (command.diagnose && !command.drag && r.status == sketch::SolveStatus::Solved) {
        for (const sketch::FreedomFact& f : sketch::analyseFreedom(r.geometry).facts) {
            protocol::FreedomFact pf;
            pf.kind = f.kind;
            pf.shape = f.shape;
            if (f.kind == "position") pf.moves = f.moves;
            pf.elements = f.elements;
            m.freedom.push_back(std::move(pf));
        }
    }
    m.conflicting = r.conflicting;
    m.redundant = r.redundant;
    m.partiallyRedundant = r.partiallyRedundant;
    for (const auto& [id, value] : r.reference) m.reference[id] = reportedValue(r.geometry, id, value);
    m.frame = toProtocol(frameOf(command.plane));
    m.problem = solveProblem(r);
    if (r.drag) {
        protocol::SketchDragResult dr;
        for (const auto& p : r.drag->points) {
            protocol::DragPointResult pr;
            pr.id = p.point;
            pr.error = p.error;
            pr.moved = p.moved;
            dr.points.push_back(std::move(pr));
        }
        dr.steps = r.drag->steps;
        dr.complete = r.drag->complete;
        m.drag = std::move(dr);
    }

    if (command.profiles && r.status == sketch::SolveStatus::Solved) {
        throwIfCancelled(cancelled, "Command \"sketch.solve\"");
        const auto tp = Clock::now();
        const ProfileResult profiles = findRegions(r.geometry);
        if (!m.problem) m.problem = intersectProblem(profiles);
        // A region is determined when every curve of its loops is. Without the element states nothing is known.
        std::map<std::string, std::string> states;
        const bool known = command.diagnose && r.diagnosed;
        if (known)
            for (const auto& [id, state] : sketch::entityStates(r.geometry, r)) states[id] = sketch::nameOf(state);
        const auto full = [&](const Loop& loop) {
            return std::all_of(loop.curves.begin(), loop.curves.end(), [&](const LoopCurve& c) {
                const auto it = states.find(c.id);
                return it != states.end() && it->second == "full";
            });
        };
        PayloadWriter w;
        for (const RegionInfo& region : profiles.regions) {
            const RegionTriangles tri = triangulateRegion(region, r.geometry);
            protocol::Region pr;
            pr.key = region.key;
            pr.outer = region.outerIds();
            pr.holes = region.holeIds();
            pr.area = region.area;
            pr.determined = known && full(region.outer) && std::all_of(region.holes.begin(), region.holes.end(), full);
            pr.fill.positions = w.add(tri.uv);
            pr.fill.indices = w.add(tri.indices);
            pr.fill.triangleCount = static_cast<std::int64_t>(tri.indices.size() / 3);
            for (const auto& loop : tri.loops) pr.loops.push_back(w.add(loop));
            m.profiles.push_back(std::move(pr));
        }
        out.payload = std::move(w.bytes());
        m.profilesMs = msSince(tp);
    }
    m.timeMs = msSince(t0);
    return out;
}

Answer<protocol::ModelResult> Model::sync(const protocol::ModelSyncCommand& command, const CancelCheck& cancelled) {
    const auto t0 = Clock::now();
    const protocol::HalfCubeDocument& doc = command.document;
    checkDocument(doc);
    const std::set<std::string> previewed = command.previewFeatures ? std::set<std::string>(command.previewFeatures->begin(), command.previewFeatures->end())
                                                                    : std::set<std::string>{};

    Answer<protocol::ModelResult> out;
    protocol::ModelResult& m = out.message;
    m.revision = command.revision;
    m.purpose = command.purpose;
    double meshMs = 0.0, encodeMs = 0.0;
    std::set<std::string> present;

    for (std::size_t i = 0; i < doc.timeline.size(); ++i) {
        throwIfCancelled(cancelled, "The rebuild of revision " + std::to_string(command.revision));
        const std::string path = "document.timeline[" + std::to_string(i) + "]";
        const auto ts = Clock::now();
        if (const auto* sf = std::get_if<protocol::SketchFeature>(&doc.timeline[i])) {
            present.insert(sf->id);
            const std::string key = "sketch\n" + protocol::toJsonValue(sf->plane).dump() + "\n" + protocol::toJsonValue(sf->sketch).dump();
            auto it = sketches_.find(sf->id);
            if (it != sketches_.end() && it->second.key == key) {
                it->second.status.cached = true;
                it->second.status.ms = msSince(ts);
                m.steps.push_back(it->second.status);
                continue;
            }
            SketchStep step;
            step.key = key;
            step.frame = frameOf(sf->plane);
            const sketch::Sketch input = toSketch(sf->sketch, path + ".sketch");
            sketch::SolveOptions options;
            options.diagnose = false;  // the rebuild needs the geometry, not the element states
            const sketch::SolveResult r = solveAt(input, path + ".sketch", options);
            step.status.featureId = sf->id;
            step.status.problem = solveProblem(r);
            if (r.status == sketch::SolveStatus::Solved) {
                step.usable = true;
                step.solved = r.geometry;
                step.profiles = findRegions(r.geometry);
                step.status.problem = intersectProblem(step.profiles);
                step.status.state = step.status.problem ? "warning" : "ok";
            } else {
                step.status.state = "error";
            }
            step.status.ms = msSince(ts);
            m.steps.push_back(step.status);
            sketches_[sf->id] = std::move(step);
            continue;
        }

        const auto& ef = std::get<protocol::ExtrudeFeature>(doc.timeline[i]);
        present.insert(ef.id);
        const SketchStep& source = sketches_.at(ef.profile.sketch);
        const std::string key = "extrude\n" + source.key + "\n" + ef.profile.region + "\n" + ef.extent + "\n" + exact(ef.distance.value) + "\n" +
                                ef.id + "\n" + ef.body;
        auto it = extrudes_.find(ef.id);
        if (it != extrudes_.end() && it->second.key == key) {
            it->second.status.cached = true;
            it->second.status.ms = msSince(ts);
            m.steps.push_back(it->second.status);
            continue;
        }
        ExtrudeStep step;
        step.key = key;
        step.status.featureId = ef.id;
        step.status.state = "error";
        if (!source.usable) {
            step.status.problem = makeProblem(protocol::problem::kUpstreamFailed,
                                              "Extrusion " + ef.id + " needs sketch " + ef.profile.sketch + ", which failed.", {ef.profile.sketch});
        } else {
            const RegionInfo* region = nullptr;
            for (const auto& r : source.profiles.regions)
                if (r.key == ef.profile.region) region = &r;
            if (!region && source.profiles.regions.empty()) {
                step.status.problem = makeProblem(protocol::problem::kProfileOpen,
                                                  "Extrusion " + ef.id + ": sketch " + ef.profile.sketch + " has no closed region.", {ef.profile.sketch});
            } else if (!region) {
                step.status.problem = makeProblem(protocol::problem::kProfileNotFound,
                                                  "Extrusion " + ef.id + ": sketch " + ef.profile.sketch + " has no region " + ef.profile.region +
                                                      " any more (its shape changed). Choose the profile again.",
                                                  {ef.profile.region});
            } else {
                ExtrudeParams params;
                params.featureId = ef.id;
                params.extent = ef.extent;
                params.distance = ef.distance.value;
                ExtrudeOutcome result = extrudeRegion(*region, source.solved, source.frame, params);
                step.status.check = result.check;
                step.status.problem = result.problem;
                if (result.body) {
                    step.status.state = "ok";
                    MeshedBody meshed = meshBody(*result.body, ef.body, ef.id, shortHash(key));
                    meshMs += meshed.meshMs;
                    encodeMs += meshed.encodeMs;
                    step.body = std::move(result.body);
                    step.mesh = std::move(meshed);
                }
            }
        }
        step.status.ms = msSince(ts);
        m.steps.push_back(step.status);
        extrudes_[ef.id] = std::move(step);
    }

    // One cache entry per step: steps that left the document (a cancelled preview, an undone step) are dropped.
    std::erase_if(sketches_, [&](const auto& e) { return !present.count(e.first); });
    std::erase_if(extrudes_, [&](const auto& e) { return !present.count(e.first); });

    const auto te = Clock::now();
    PayloadWriter w;
    for (const auto& feature : doc.timeline) {
        const auto* ef = std::get_if<protocol::ExtrudeFeature>(&feature);
        if (!ef) continue;
        const ExtrudeStep& step = extrudes_.at(ef->id);
        if (!step.mesh) continue;
        protocol::BodyResult body = step.mesh->info;
        body.preview = previewed.count(ef->id) > 0;
        const std::int64_t shift = w.addBlock(step.mesh->block);
        for (protocol::BufferRef* ref : {&body.mesh.positions, &body.mesh.normals, &body.mesh.indices, &body.mesh.triangleFace, &body.mesh.edgePoints})
            ref->offset += shift;
        m.bodies.push_back(std::move(body));
    }
    out.payload = std::move(w.bytes());
    encodeMs += msSince(te);

    bool warning = false, error = false;
    for (const auto& s : m.steps) {
        warning = warning || s.state == "warning";
        error = error || s.state == "error";
    }
    m.outcome = error ? "error" : warning ? "warning" : "ok";
    m.timings.totalMs = msSince(t0);
    m.timings.meshMs = meshMs;
    m.timings.encodeMs = encodeMs;
    m.timings.rebuildMs = std::max(0.0, m.timings.totalMs - meshMs - encodeMs);
    return out;
}

} // namespace hc::model
