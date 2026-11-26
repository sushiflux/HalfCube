#include "core/errors.hpp"

#include "generated/protocol.hpp"

#include <Standard_Failure.hxx>

#include <typeinfo>

namespace hc {

EngineError::EngineError(std::string code, const std::string& message, std::string detail)
    : std::runtime_error(message), code_(std::move(code)), detail_(std::move(detail)) {}

std::string describeCurrentException() {
    try {
        throw;
    } catch (const Standard_Failure& e) {
        const char* what = e.what();
        return std::string(e.ExceptionType()) + ": " + (what && *what ? what : "(no message)");
    } catch (const std::exception& e) {
        return std::string(typeid(e).name()) + ": " + e.what();
    } catch (...) {
        return "unknown exception (not derived from std::exception or Standard_Failure)";
    }
}

void throwIfCancelled(const CancelCheck& cancelled, const std::string& what) {
    if (cancelled && cancelled()) throw EngineError(protocol::err::kCancelled, what + " was cancelled.");
}

} // namespace hc
