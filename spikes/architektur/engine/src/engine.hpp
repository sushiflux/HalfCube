// Transport-independent engine core: reads command headers, keeps the recipe, rebuilds it and writes replies.
// The native main (stdio frames, two threads) and the WebAssembly main (one call per message) both drive it.
#pragma once

#include "json.hpp"
#include "mesh.hpp"
#include "model.hpp"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

namespace hc {

// Sink for engine messages. Must be safe to call from several threads (native: reader and compute thread).
class Output {
public:
    virtual ~Output() = default;
    virtual void send(const std::string& header, const std::vector<uint8_t>* payload) = 0;
};

struct EngineOptions {
    bool debugCommands = false;  // accept debugCrash, debugPayload and debug.spin
    std::string platform;        // "windows-x64", "wasm32", ...
    bool pingWhileBusy = false;  // receive() runs on its own thread while runNext() computes
    bool cancelWhileBusy = false;
    // Optional extra cancel source, polled during rebuilds (WebAssembly: shared cancel flag).
    std::function<bool(int64_t requestId)> externalCancel;
};

class Engine {
public:
    Engine(Output& out, EngineOptions opt);

    // Handles one incoming message. hello, ping and cancel are answered at once; everything else is queued.
    void receive(std::string_view header, std::vector<uint8_t> payload);

    // Runs one queued command. With wait, blocks until a command arrives or stop is requested.
    // Returns false when nothing was run.
    bool runNext(bool wait);

    // Stops processing (end of input or shutdown): cancels the running command, drops the queue.
    void requestStop();
    bool stopped() const { return stop_.load(); }

private:
    struct Pending {
        int64_t id = 0;
        std::string type;
        Json msg;
        std::vector<uint8_t> payload;
        bool changesRecipe = false;
        int64_t recipeVersion = -1;
        bool cancelledWhileQueued = false;
    };

    void handleHello(int64_t id, const Json& msg);
    void handleCancel(int64_t id, const Json& msg);
    void execute(Pending& p);
    void rebuildAndReply(const Pending& p);
    bool isCancelled(int64_t id) const;
    bool newerRecipeChangeQueued(int64_t version);

    Json base(const char* type, int64_t replyTo, int64_t recipeVersion) const;
    void sendJson(const Json& j, const std::vector<uint8_t>* payload = nullptr);
    void sendError(const Json& replyTo, const char* code, const std::string& message, int64_t recipeVersion);

    Output& out_;
    EngineOptions opt_;

    std::mutex m_;
    std::condition_variable cv_;
    std::deque<Pending> queue_;
    int64_t runningId_ = 0;            // guarded by m_
    bool runningChangesRecipe_ = false;
    int64_t runningVersion_ = -1;
    std::atomic<int64_t> cancelTarget_{0};
    std::atomic<int64_t> supersededTarget_{0};
    std::atomic<int64_t> supersededBy_{-1};
    std::atomic<bool> stop_{false};
    std::atomic<bool> hello_{false};
    std::atomic<int64_t> version_{-1};  // version of the recipe the engine holds

    // Compute-thread state.
    Model model_;
    Recipe recipe_;
    bool hasRecipe_ = false;
    MeshParams meshParams_;
    struct MeshCacheEntry {
        uint64_t key = 0;
        MeshBlock block;
    };
    std::map<std::string, MeshCacheEntry> meshCache_;
};

} // namespace hc
