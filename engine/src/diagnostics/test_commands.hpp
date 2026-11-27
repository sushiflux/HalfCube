// Test commands diagnostics.crash and diagnostics.hang. They exist only in engines built with the CMake option
// HALFCUBE_TEST_COMMANDS=ON and serve the tests of the desktop supervisor.
#pragma once

#if defined(HALFCUBE_TEST_COMMANDS)

#include "core/errors.hpp"
#include "generated/protocol.hpp"

#include <cstdint>
#include <mutex>
#include <string>

namespace hc::testing {

// Ends the engine on purpose: "abort" (std::abort), "nullcall" (call through a null function pointer) or "intdiv"
// (integer division by zero). The process dies. Returns only by throwing EngineError "crash_not_triggered" when the
// platform survives the fault.
void crash(const std::string& mode, std::int64_t requestId);

// busy: computes for c.ms milliseconds (or until cancelled when ms is missing) and returns how long it ran;
// throws EngineError "cancelled" when cancelled. frozen: locks engineLock (the engine's queue lock, which the
// native reader needs for ping, cancel and every new command) and never returns, so the engine answers nothing.
protocol::HangResult hang(const protocol::DiagnosticsHangCommand& c, const CancelCheck& cancelled, std::mutex& engineLock);

} // namespace hc::testing

#endif
