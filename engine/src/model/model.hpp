// The two computing commands of protocol 2.
//   sketch.solve  stateless: sketch in, solved sketch (states, conflicts, reference dimensions, regions) out.
//   model.sync    the whole document in; the timeline is rebuilt in order, and every step whose resolved inputs are
//                 unchanged since the previous rebuild comes from the cache (one entry per step). The engine keeps no
//                 editing state: after a restart the client simply sends the document again.
#pragma once

#include "core/errors.hpp"
#include "generated/protocol.hpp"
#include "model/document.hpp"
#include "model/geometry.hpp"
#include "model/profiles.hpp"
#include "sketch/sketch_solver.hpp"

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace pc::model {

template <class Message>
struct Answer {
    Message message;
    std::vector<std::uint8_t> payload;
};

// Solves a sketch read from `path` (for messages). Maps sketch errors to EngineError(bad_document).
sketch::SolveResult solveAt(const sketch::Sketch& s, const std::string& path, const sketch::SolveOptions& options);

Answer<protocol::SketchSolveResult> solveSketch(const protocol::SketchSolveCommand& command, const CancelCheck& cancelled);

class Model {
public:
    Answer<protocol::ModelResult> sync(const protocol::ModelSyncCommand& command, const CancelCheck& cancelled);

    // For tests: number of cached steps.
    std::size_t cachedSteps() const { return sketches_.size() + extrudes_.size(); }

private:
    struct SketchStep {
        std::string key;
        protocol::StepStatus status;
        bool usable = false;  // solved: its regions can be extruded
        sketch::Sketch solved;
        Frame frame;
        ProfileResult profiles;
    };
    struct ExtrudeStep {
        std::string key;
        protocol::StepStatus status;
        std::optional<BodyShape> body;
        std::optional<MeshedBody> mesh;
    };

    std::map<std::string, SketchStep> sketches_;
    std::map<std::string, ExtrudeStep> extrudes_;
};

} // namespace pc::model
