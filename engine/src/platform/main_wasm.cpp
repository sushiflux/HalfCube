// WebAssembly engine: the same engine core as the native process, driven by calls from the worker script.
// The worker writes a message header (and payload) into linear memory and calls hc_handle; replies come back
// synchronously through Module.onEngineMessage(headerText, payloadArrayBuffer | null).
// Single-threaded: ping and cancel messages are only read between commands. A running command can still be
// cancelled through Module.cancelFlags, an Int32Array on a SharedArrayBuffer whose slot 0 the client sets to the
// request id to cancel.

#include "core/engine.hpp"

#include <emscripten/emscripten.h>

#include <memory>
#include <string_view>
#include <vector>

// clang-format off
EM_JS(void, hc_js_emit, (const char* h, int hl, const uint8_t* p, int pl), {
    const header = new TextDecoder().decode(HEAPU8.subarray(h, h + hl));
    // slice() copies out of linear memory into an own ArrayBuffer that the worker can transfer.
    const payload = pl > 0 ? HEAPU8.slice(p, p + pl).buffer : null;
    Module["onEngineMessage"](header, payload);
});

EM_JS(int, hc_js_cancel_requested, (int id), {
    const f = Module["cancelFlags"];
    return f ? (Atomics.load(f, 0) === id ? 1 : 0) : 0;
});
// clang-format on

namespace {

class JsOutput : public hc::Output {
public:
    void send(const std::string& header, const std::vector<std::uint8_t>* payload) override {
        hc_js_emit(header.data(), static_cast<int>(header.size()), payload && !payload->empty() ? payload->data() : nullptr,
                   payload ? static_cast<int>(payload->size()) : 0);
    }
};

JsOutput gOut;
std::unique_ptr<hc::Engine> gEngine;

} // namespace

extern "C" {

// Creates the engine (once). Returns the protocol version.
EMSCRIPTEN_KEEPALIVE int hc_init(int hasCancelFlags) {
    if (!gEngine) {
        hc::EngineOptions options;
        options.pingWhileBusy = false;
        options.cancelWhileBusy = hasCancelFlags != 0;
        if (hasCancelFlags)
            options.externalCancel = [](std::int64_t id) { return hc_js_cancel_requested(static_cast<int>(id)) != 0; };
        gEngine = std::make_unique<hc::Engine>(gOut, options);
    }
    return hc::protocol::kVersion;
}

// Handles one message and runs everything it queued before returning.
EMSCRIPTEN_KEEPALIVE void hc_handle(const char* header, int headerBytes, const std::uint8_t* payload, int payloadBytes) {
    if (!gEngine) hc_init(0);
    std::vector<std::uint8_t> p;
    if (payloadBytes > 0) p.assign(payload, payload + payloadBytes);
    gEngine->receive(std::string_view(header, static_cast<std::size_t>(headerBytes)), std::move(p));
    while (gEngine->runNext(false)) {
    }
}

} // extern "C"
