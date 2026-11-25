#include "core/engine.hpp"

#include "core/errors.hpp"
#include "diagnostics/test_commands.hpp"
#include "kernel/kernel_selftest.hpp"
#include "partcraft/build_info.hpp"
#include "sketch/sketch_solver.hpp"
#include "sketch/solver_selftest.hpp"

#include <Standard_Version.hxx>

#include <cstdio>

#ifdef __EMSCRIPTEN__
#include <emscripten/version.h>
#endif

#ifndef PC_BUILD_TYPE
#define PC_BUILD_TYPE "unknown"
#endif

namespace pc {

namespace err = protocol::err;
namespace cmd = protocol::cmd;

namespace {

const protocol::CommandInfo* findCommand(const std::string& type) {
    for (const auto& c : protocol::kCommands)
        if (type == c.type) return &c;
    return nullptr;
}

std::string knownCommandList() {
    std::string s;
    for (const auto& c : protocol::kCommands) {
        if (c.testOnly && !build::kTestCommands) continue;
        s += (s.empty() ? "" : ", ") + std::string(c.type);
    }
    return s;
}

// Parses the fields of a queued command once at arrival, so a malformed command is refused at once instead of
// waiting in the queue. Throws protocol::FieldError.
template <class Command>
void validateAs(const Json& msg) {
    Command c;
    protocol::parse(msg, c);
}

void validateQueued(const std::string& type, const Json& msg) {
    if (type == cmd::kShutdown) validateAs<protocol::ShutdownCommand>(msg);
    else if (type == cmd::kDiagnosticsKernelSelftest) validateAs<protocol::DiagnosticsKernelSelftestCommand>(msg);
    else if (type == cmd::kDiagnosticsSolverSelftest) validateAs<protocol::DiagnosticsSolverSelftestCommand>(msg);
    else if (type == cmd::kDiagnosticsCrash) validateAs<protocol::DiagnosticsCrashCommand>(msg);
    else if (type == cmd::kDiagnosticsHang) validateAs<protocol::DiagnosticsHangCommand>(msg);
}

std::string compilerText() {
    std::string s = build::kCompiler;
#ifdef __EMSCRIPTEN__
    s += " (Emscripten " + std::to_string(__EMSCRIPTEN_MAJOR__) + "." + std::to_string(__EMSCRIPTEN_MINOR__) + "." +
         std::to_string(__EMSCRIPTEN_TINY__) + ")";
#endif
    return s;
}

std::string jsonLibraryVersion() {
    return std::to_string(NLOHMANN_JSON_VERSION_MAJOR) + "." + std::to_string(NLOHMANN_JSON_VERSION_MINOR) + "." +
           std::to_string(NLOHMANN_JSON_VERSION_PATCH);
}

} // namespace

Engine::Engine(Output& out, EngineOptions options) : out_(out), opt_(std::move(options)) {}

void Engine::sendJson(const Json& j) {
    out_.send(j.dump(-1, ' ', false, Json::error_handler_t::replace), nullptr);
}

void Engine::sendError(std::optional<std::int64_t> replyTo, const char* code, const std::string& message,
                       const std::string& detail, const std::string& command) {
    protocol::ErrorMessage e;
    e.code = code;
    e.message = message;
    if (!detail.empty()) e.detail = detail;
    if (!command.empty()) e.command = command;
    sendJson(protocol::messageJson(e, replyTo));
}

void Engine::receive(std::string_view header, std::vector<std::uint8_t> payload) {
    if (stop_) return;
    Json msg;
    try {
        msg = Json::parse(header);
    } catch (const Json::exception& e) {
        sendError(std::nullopt, err::kBadMessage, "The engine received a message header that is not valid JSON.", e.what());
        return;
    }
    if (!msg.is_object()) {
        sendError(std::nullopt, err::kBadMessage, "The engine received a message header that is not a JSON object.");
        return;
    }
    std::int64_t id = 0;
    try {
        const Json* idField = protocol::findField(msg, "id");
        if (!idField) throw protocol::FieldError("The message field \"id\" is missing.");
        id = protocol::readInteger(*idField, "The message field \"id\"", 1, protocol::kMaxRequestId);
    } catch (const protocol::FieldError& e) {
        sendError(std::nullopt, err::kBadMessage, e.what());
        return;
    }
    const Json* typeField = protocol::findField(msg, "type");
    if (!typeField || !typeField->is_string()) {
        sendError(id, err::kBadMessage, "The message field \"type\" is missing or not a string.");
        return;
    }
    const std::string type = typeField->get<std::string>();
    const protocol::CommandInfo* info = findCommand(type);
    if (!info) {
        sendError(id, err::kUnknownCommand, "Unknown command \"" + type + "\". This engine knows: " + knownCommandList() + ".", {}, type);
        return;
    }
    if (!payload.empty()) {
        sendError(id, err::kBadMessage,
                  "Command \"" + type + "\" takes no binary payload, but " + std::to_string(payload.size()) + " bytes arrived.", {}, type);
        return;
    }
    if (type == cmd::kHello) {
        handleHello(id, msg);
        return;
    }
    if (!hello_) {
        sendError(id, err::kNotInitialized, "Command \"" + type + "\" arrived before the hello handshake; send \"hello\" first.", {}, type);
        return;
    }
    if (info->testOnly && !build::kTestCommands) {
        sendError(id, err::kTestCommandsDisabled,
                  "Command \"" + type + "\" is a test command; this engine was built without test commands "
                  "(CMake option PARTCRAFT_TEST_COMMANDS=ON enables them).", {}, type);
        return;
    }
    try {
        if (type == cmd::kPing) {
            validateAs<protocol::PingCommand>(msg);
            protocol::Pong pong;
            {
                std::lock_guard<std::mutex> lk(m_);
                if (runningId_) pong.busyWith = runningId_;
                pong.queued = static_cast<std::int64_t>(queue_.size());
            }
            reply(id, pong);
            return;
        }
        if (type == cmd::kCancel) {
            handleCancel(id, msg);
            return;
        }
        validateQueued(type, msg);
    } catch (const protocol::FieldError& e) {
        sendError(id, err::kBadMessage, e.what(), {}, type);
        return;
    }
    {
        std::lock_guard<std::mutex> lk(m_);
        queue_.push_back(Pending{id, type, std::move(msg), false});
    }
    cv_.notify_one();
}

void Engine::handleHello(std::int64_t id, const Json& msg) {
    protocol::HelloCommand c;
    try {
        protocol::parse(msg, c);
    } catch (const protocol::FieldError& e) {
        sendError(id, err::kBadMessage, e.what(), {}, cmd::kHello);
        return;
    }
    if (c.protocol != protocol::kVersion) {
        sendError(id, err::kProtocolMismatch,
                  "The engine speaks protocol version " + std::to_string(protocol::kVersion) + ", the client \"" + c.client +
                      "\" asked for version " + std::to_string(c.protocol) +
                      ". User interface and engine come from different builds; reinstall Partcraft.",
                  {}, cmd::kHello);
        return;
    }
    protocol::HelloResult r;
    r.protocol = protocol::kVersion;
    r.engine.version = build::kVersion;
    r.engine.versionFull = build::kVersionFull;
    r.engine.buildType = PC_BUILD_TYPE;
    r.engine.platform = build::kPlatform;
    r.engine.os = build::kOs;
    r.engine.compiler = compilerText();
    r.engine.testCommands = build::kTestCommands;
    r.components.occt = OCC_VERSION_COMPLETE;
    r.components.planegcs.source = build::kPlanegcsSource;
    r.components.planegcs.commit = build::kPlanegcsCommit;
    r.components.eigen = sketch::eigenVersion();
    r.components.boost = sketch::boostVersion();
    r.components.nlohmannJson = jsonLibraryVersion();
    r.capabilities.pingWhileBusy = opt_.pingWhileBusy;
    r.capabilities.cancelWhileBusy = opt_.cancelWhileBusy;
    r.limits.maxHeaderBytes = protocol::kMaxHeaderBytes;
    r.limits.maxPayloadBytes = protocol::kMaxPayloadBytes;
    r.limits.payloadAlignment = protocol::kPayloadAlignment;
    r.limits.maxRequestId = protocol::kMaxRequestId;
    hello_ = true;
    reply(id, r);
}

void Engine::handleCancel(std::int64_t id, const Json& msg) {
    protocol::CancelCommand c;
    protocol::parse(msg, c);
    protocol::CancelResult r;
    r.target = c.target;
    r.state = "notFound";
    {
        std::lock_guard<std::mutex> lk(m_);
        for (auto& q : queue_) {
            if (q.id == c.target && !q.cancelledWhileQueued) {
                q.cancelledWhileQueued = true;
                r.state = "queued";
            }
        }
        if (runningId_ == c.target) {
            cancelTarget_ = c.target;
            r.state = "running";
        }
    }
    reply(id, r);
}

bool Engine::isCancelled(std::int64_t id) const {
    if (stop_ || cancelTarget_.load() == id) return true;
    return opt_.externalCancel && opt_.externalCancel(id);
}

void Engine::requestStop() {
    stop_ = true;
    {
        std::lock_guard<std::mutex> lk(m_);
        queue_.clear();
    }
    cv_.notify_all();
}

bool Engine::runNext(bool wait) {
    Pending p;
    {
        std::unique_lock<std::mutex> lk(m_);
        if (wait) cv_.wait(lk, [&] { return stop_.load() || !queue_.empty(); });
        if (stop_ || queue_.empty()) return false;
        p = std::move(queue_.front());
        queue_.pop_front();
        runningId_ = p.id;
    }
    try {
        execute(p);
    } catch (const EngineError& e) {
        sendError(p.id, e.code().c_str(), e.what(), e.detail(), p.type);
    } catch (const protocol::FieldError& e) {
        sendError(p.id, err::kBadMessage, e.what(), {}, p.type);
    } catch (...) {
        const std::string detail = describeCurrentException();
        std::fprintf(stderr, "partcraft-engine: command \"%s\" (id %lld) failed: %s\n", p.type.c_str(),
                     static_cast<long long>(p.id), detail.c_str());
        std::fflush(stderr);
        sendError(p.id, err::kInternal,
                  "Command \"" + p.type + "\" failed inside the engine because of an unexpected error. The engine keeps "
                  "running; the technical details name the cause.",
                  detail, p.type);
    }
    {
        std::lock_guard<std::mutex> lk(m_);
        runningId_ = 0;
        if (cancelTarget_ == p.id) cancelTarget_ = 0;
    }
    return true;
}

void Engine::execute(const Pending& p) {
    if (p.cancelledWhileQueued)
        throw EngineError(err::kCancelled, "Command \"" + p.type + "\" (id " + std::to_string(p.id) + ") was cancelled before it started.");
    const std::int64_t id = p.id;
    const CancelCheck cancelled = [this, id] { return isCancelled(id); };

    if (p.type == cmd::kShutdown) {
        reply(id, protocol::Bye{});
        stop_ = true;
        cv_.notify_all();
        return;
    }
    if (p.type == cmd::kDiagnosticsKernelSelftest) {
        reply(id, kernel::runSelftest(cancelled));
        return;
    }
    if (p.type == cmd::kDiagnosticsSolverSelftest) {
        reply(id, sketch::runSelftest(cancelled));
        return;
    }
#if defined(PARTCRAFT_TEST_COMMANDS)
    if (p.type == cmd::kDiagnosticsCrash) {
        protocol::DiagnosticsCrashCommand c;
        protocol::parse(p.msg, c);
        testing::crash(c.mode, id);  // returns only by throwing crash_not_triggered
        return;
    }
    if (p.type == cmd::kDiagnosticsHang) {
        protocol::DiagnosticsHangCommand c;
        protocol::parse(p.msg, c);
        reply(id, testing::hang(c, cancelled, m_));
        return;
    }
#endif
    throw EngineError(err::kInternal, "Command \"" + p.type + "\" was accepted but has no handler in this engine build.");
}

} // namespace pc
