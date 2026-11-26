// Transport-independent engine core: reads command headers, answers hello, ping and cancel at once, queues every
// other command and runs it. The native main (stdio frames, reader thread plus compute thread) and the WebAssembly
// main (one call per message, single-threaded) both drive this class.
#pragma once

#include "generated/protocol.hpp"
#include "model/model.hpp"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace pc {

using Json = protocol::Json;

// Sink for engine messages. Must be safe to call from several threads (native: reader and compute thread).
class Output {
public:
    virtual ~Output() = default;
    virtual void send(const std::string& header, const std::vector<std::uint8_t>* payload) = 0;
};

struct EngineOptions {
    bool pingWhileBusy = false;    // receive() runs on its own thread while runNext() computes
    bool cancelWhileBusy = false;  // a cancel can reach the running command
    // Optional extra cancel source, polled by running commands (WebAssembly: shared cancel flag).
    std::function<bool(std::int64_t requestId)> externalCancel;
};

class Engine {
public:
    Engine(Output& out, EngineOptions options);

    // Handles one incoming message. hello, ping and cancel are answered at once; everything else is validated and
    // queued. Thread-safe against a concurrent runNext().
    void receive(std::string_view header, std::vector<std::uint8_t> payload);

    // Runs one queued command. With wait, blocks until a command arrives or stop is requested.
    // Returns false when nothing was run.
    bool runNext(bool wait);

    // Stops processing (end of input or shutdown): cancels the running command, drops the queue.
    void requestStop();
    bool stopped() const { return stop_.load(); }

private:
    struct Pending {
        std::int64_t id = 0;
        std::string type;
        Json msg;
        bool cancelledWhileQueued = false;
    };

    void handleHello(std::int64_t id, const Json& msg);
    void handleCancel(std::int64_t id, const Json& msg);
    void execute(const Pending& p);
    bool isCancelled(std::int64_t id) const;

    void sendJson(const Json& j, const std::vector<std::uint8_t>* payload = nullptr);
    template <class Message>
    void reply(std::int64_t replyTo, const Message& m) {
        sendJson(protocol::messageJson(m, replyTo));
    }
    // Reply with a binary payload (buffers referenced by offset and length in the header).
    template <class Message>
    void replyWithPayload(std::int64_t replyTo, const Message& m, const std::vector<std::uint8_t>& payload) {
        checkPayloadSize(payload.size(), Message::kType);
        sendJson(protocol::messageJson(m, replyTo), &payload);
    }
    static void checkPayloadSize(std::size_t bytes, std::string_view message);
    void sendError(std::optional<std::int64_t> replyTo, const char* code, const std::string& message,
                   const std::string& detail = {}, const std::string& command = {});

    Output& out_;
    EngineOptions opt_;

    std::mutex m_;  // guards queue_ and running state; diagnostics.hang "frozen" holds it on purpose
    std::condition_variable cv_;
    std::deque<Pending> queue_;
    std::int64_t runningId_ = 0;
    std::atomic<std::int64_t> cancelTarget_{0};
    std::atomic<bool> stop_{false};
    std::atomic<bool> hello_{false};

    // Computing state, only touched by the thread that runs commands.
    model::Model model_;
    std::int64_t lastRevision_ = 0;  // highest model.sync revision accepted
};

} // namespace pc
