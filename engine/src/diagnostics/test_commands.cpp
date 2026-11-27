#include "diagnostics/test_commands.hpp"

#if defined(HALFCUBE_TEST_COMMANDS)

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>

namespace hc::testing {

namespace {

// volatile keeps the compiler from folding the deliberate faults away.
volatile int gZero = 0;
int (*volatile gNullFunction)(int) = nullptr;

using Clock = std::chrono::steady_clock;

double msSince(Clock::time_point t0) { return std::chrono::duration<double, std::milli>(Clock::now() - t0).count(); }

} // namespace

void crash(const std::string& mode, std::int64_t requestId) {
    std::fprintf(stderr, "halfcube-engine: diagnostics.crash \"%s\" requested by command %lld\n", mode.c_str(),
                 static_cast<long long>(requestId));
    std::fflush(stderr);
    if (mode == "abort") std::abort();
    if (mode == "nullcall") {
        const int r = gNullFunction(1);
        std::fprintf(stderr, "halfcube-engine: the null call returned %d\n", r);
    }
    if (mode == "intdiv") {
        const int q = 7 / gZero;
        std::fprintf(stderr, "halfcube-engine: the division by zero returned %d\n", q);
    }
    throw EngineError(protocol::err::kCrashNotTriggered,
                      "diagnostics.crash \"" + mode + "\" did not end the engine on this platform; the engine keeps running.");
}

protocol::HangResult hang(const protocol::DiagnosticsHangCommand& c, const CancelCheck& cancelled, std::mutex& engineLock) {
    const auto t0 = Clock::now();
    if (c.mode == "frozen") {
        std::fprintf(stderr, "halfcube-engine: diagnostics.hang \"frozen\": the engine stops answering until it is ended\n");
        std::fflush(stderr);
        std::lock_guard<std::mutex> hold(engineLock);
        for (;;) std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    protocol::HangResult r;
    r.mode = "busy";
    for (;;) {
        const double elapsed = msSince(t0);
        if (c.ms && elapsed >= static_cast<double>(*c.ms)) break;
        if (cancelled && cancelled())
            throw EngineError(protocol::err::kCancelled,
                              "diagnostics.hang \"busy\" was cancelled after " + std::to_string(static_cast<long long>(elapsed)) + " ms.");
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    r.ms = msSince(t0);
    return r;
}

} // namespace hc::testing

#endif
