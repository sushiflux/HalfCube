// Error type of the engine and the cancellation check shared by long-running work.
#pragma once

#include <functional>
#include <stdexcept>
#include <string>

namespace hc {

// A failure with a stable protocol error code (protocol::err::*) and a complete message written by the engine.
// detail carries raw technical text (exception type and text) when there is one.
class EngineError : public std::runtime_error {
public:
    EngineError(std::string code, const std::string& message, std::string detail = {});

    const std::string& code() const noexcept { return code_; }
    const std::string& detail() const noexcept { return detail_; }

private:
    std::string code_;
    std::string detail_;
};

// "Type: text" of the exception currently being handled (OCCT Standard_Failure, std::exception or unknown).
// Only call inside a catch block.
std::string describeCurrentException();

// Polled by long-running work; returns true when the work should stop as soon as possible.
using CancelCheck = std::function<bool()>;

// Throws EngineError with code "cancelled" when cancelled() is true. what names the interrupted work.
void throwIfCancelled(const CancelCheck& cancelled, const std::string& what);

} // namespace hc
