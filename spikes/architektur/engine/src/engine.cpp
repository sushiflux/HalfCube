#include "engine.hpp"

#include "protocol.hpp"

#include <Standard_Failure.hxx>
#include <Standard_Version.hxx>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>

#ifdef __EMSCRIPTEN__
#include <emscripten/version.h>
#endif

#ifndef HC_ENGINE_VERSION
#define HC_ENGINE_VERSION "0.0.0-spike"
#endif

namespace hc {

namespace err = protocol::err;

namespace {

using Clock = std::chrono::steady_clock;
double msSince(Clock::time_point t0) { return std::chrono::duration<double, std::milli>(Clock::now() - t0).count(); }

std::string describeCurrentException() {
    try {
        throw;
    } catch (const Standard_Failure& e) {
        return std::string(e.ExceptionType()) + ": " + (e.what() ? e.what() : "");
    } catch (const std::exception& e) {
        return std::string("std::exception: ") + e.what();
    } catch (...) {
        return "unknown exception";
    }
}

bool asRequestId(const Json* v, int64_t& out) {
    if (!v || !v->isNumber()) return false;
    const double d = v->number();
    if (d != std::floor(d) || d < 1 || d > static_cast<double>(protocol::kMaxRequestId)) return false;
    out = static_cast<int64_t>(d);
    return true;
}

bool asVersion(const Json* v, int64_t& out) {
    if (!v || !v->isNumber()) return false;
    const double d = v->number();
    if (d != std::floor(d) || d < 0 || d > 9007199254740991.0) return false;
    out = static_cast<int64_t>(d);
    return true;
}

std::string buildInfo() {
    std::string s;
#if defined(__EMSCRIPTEN__)
    s = "emscripten " + std::to_string(__EMSCRIPTEN_MAJOR__) + "." + std::to_string(__EMSCRIPTEN_MINOR__) + "." +
        std::to_string(__EMSCRIPTEN_TINY__);
#elif defined(_MSC_VER)
    s = "msvc " + std::to_string(_MSC_FULL_VER);
#elif defined(__clang__)
    s = std::string("clang ") + __clang_version__;
#elif defined(__GNUC__)
    s = std::string("gcc ") + __VERSION__;
#endif
#ifdef HC_BUILD_FLAGS
    s += std::string(", ") + HC_BUILD_FLAGS;
#endif
    return s;
}

// Deliberate crashes for the crash-recovery tests. volatile keeps the compiler from folding them away.
volatile int gZero = 0;
int (*volatile gNullFn)(int) = nullptr;

uint32_t fnv1a32(const uint8_t* p, size_t n) {
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < n; ++i) {
        h ^= p[i];
        h *= 16777619u;
    }
    return h;
}

} // namespace

Engine::Engine(Output& out, EngineOptions opt) : out_(out), opt_(std::move(opt)) {}

Json Engine::base(const char* type, int64_t replyTo, int64_t recipeVersion) const {
    Json j = Json::object();
    j["type"] = type;
    j["replyTo"] = replyTo > 0 ? Json(static_cast<long long>(replyTo)) : Json();
    j["recipeVersion"] = static_cast<long long>(recipeVersion);
    return j;
}

void Engine::sendJson(const Json& j, const std::vector<uint8_t>* payload) { out_.send(j.dump(), payload); }

void Engine::sendError(const Json& replyTo, const char* code, const std::string& message, int64_t recipeVersion) {
    Json j = Json::object();
    j["type"] = "error";
    j["replyTo"] = replyTo;
    j["recipeVersion"] = static_cast<long long>(recipeVersion);
    j["code"] = code;
    j["message"] = message;
    sendJson(j);
}

void Engine::receive(std::string_view header, std::vector<uint8_t> payload) {
    if (stop_) return;
    Json msg;
    try {
        msg = Json::parse(header);
    } catch (const JsonError& e) {
        sendError(Json(), err::kBadMessage, std::string("The engine received a message that is not valid JSON: ") + e.what(), version_);
        return;
    }
    if (!msg.isObject()) {
        sendError(Json(), err::kBadMessage, "The engine received a message that is not a JSON object.", version_);
        return;
    }
    int64_t id = 0;
    if (!asRequestId(msg.find("id"), id)) {
        sendError(Json(), err::kBadMessage, "The message field \"id\" must be an integer from 1 to 2147483647.", version_);
        return;
    }
    const Json idJson(static_cast<long long>(id));
    const Json* typeJ = msg.find("type");
    if (!typeJ || !typeJ->isString()) {
        sendError(idJson, err::kBadMessage, "The message field \"type\" is missing or not a string.", version_);
        return;
    }
    const std::string type = typeJ->str();
    if (type == "hello") { handleHello(id, msg); return; }
    if (!hello_) {
        sendError(idJson, err::kNotInitialized, "Command \"" + type + "\" arrived before the hello handshake; send \"hello\" first.", version_);
        return;
    }
    if (type == "ping") {
        std::lock_guard<std::mutex> lk(m_);
        Json j = base("pong", id, version_);
        j["busyWith"] = runningId_ ? Json(static_cast<long long>(runningId_)) : Json();
        j["queued"] = static_cast<unsigned long long>(queue_.size());
        sendJson(j);
        return;
    }
    if (type == "cancel") { handleCancel(id, msg); return; }

    const bool isDebug = type == "debugCrash" || type == "debugPayload";
    const bool changes = type == "loadRecipe" || type == "setParameter";
    if (!changes && !isDebug && type != "shutdown") {
        sendError(idJson, err::kUnknownCommand, "Unknown command \"" + type + "\".", version_);
        return;
    }
    if (isDebug && !opt_.debugCommands) {
        sendError(idJson, err::kDebugDisabled, "Command \"" + type + "\" is a test command and is disabled in this engine.", version_);
        return;
    }
    Pending p;
    p.id = id;
    p.type = type;
    p.changesRecipe = changes;
    if (changes && !asVersion(msg.find("recipeVersion"), p.recipeVersion)) {
        sendError(idJson, err::kBadMessage, "Command \"" + type + "\" needs \"recipeVersion\", a non-negative integer.", version_);
        return;
    }
    p.msg = std::move(msg);
    p.payload = std::move(payload);
    {
        std::lock_guard<std::mutex> lk(m_);
        // A newer recipe change makes the running rebuild pointless: its answer would be stale on arrival.
        if (changes && runningId_ && runningChangesRecipe_ && runningVersion_ < p.recipeVersion) {
            supersededBy_ = p.recipeVersion;
            supersededTarget_ = runningId_;
        }
        queue_.push_back(std::move(p));
    }
    cv_.notify_one();
}

void Engine::handleHello(int64_t id, const Json& msg) {
    const Json* proto = msg.find("protocol");
    if (!proto || !proto->isNumber() || proto->number() != protocol::kVersion) {
        const std::string asked = proto && proto->isNumber() ? Json(proto->number()).dump() : std::string("none");
        sendError(Json(static_cast<long long>(id)), err::kProtocolMismatch,
                  "The engine speaks protocol version " + std::to_string(protocol::kVersion) + ", the client asked for " +
                      asked + ". User interface and engine come from different builds; reinstall the program.",
                  version_);
        return;
    }
    hello_ = true;
    Json j = base("helloResult", id, version_);
    j["protocol"] = protocol::kVersion;
    Json e = Json::object();
    e["name"] = "halfcube-engine";
    e["version"] = HC_ENGINE_VERSION;
    e["kernel"] = std::string("OCCT ") + OCC_VERSION_COMPLETE;
    e["platform"] = opt_.platform;
    e["build"] = buildInfo();
    j["engine"] = e;
    Json c = Json::object();
    c["debugCommands"] = opt_.debugCommands;
    c["pingWhileBusy"] = opt_.pingWhileBusy;
    c["cancelWhileBusy"] = opt_.cancelWhileBusy;
    j["capabilities"] = c;
    Json l = Json::object();
    l["maxHeaderBytes"] = protocol::kMaxHeaderBytes;
    l["maxPayloadBytes"] = protocol::kMaxPayloadBytes;
    l["payloadAlignment"] = protocol::kPayloadAlignment;
    j["limits"] = l;
    sendJson(j);
}

void Engine::handleCancel(int64_t id, const Json& msg) {
    int64_t target = 0;
    if (!asRequestId(msg.find("target"), target)) {
        sendError(Json(static_cast<long long>(id)), err::kBadMessage, "Command \"cancel\" needs \"target\", the id of the command to cancel.", version_);
        return;
    }
    const char* state = "notRunning";
    {
        std::lock_guard<std::mutex> lk(m_);
        for (auto& q : queue_)
            if (q.id == target && !q.cancelledWhileQueued) { q.cancelledWhileQueued = true; state = "queued"; }
        if (runningId_ == target) {
            cancelTarget_ = target;
            state = "running";
        }
    }
    Json j = base("cancelResult", id, version_);
    j["target"] = static_cast<long long>(target);
    j["state"] = state;
    sendJson(j);
}

bool Engine::isCancelled(int64_t id) const {
    if (stop_ || cancelTarget_.load() == id || supersededTarget_.load() == id) return true;
    return opt_.externalCancel && opt_.externalCancel(id);
}

bool Engine::newerRecipeChangeQueued(int64_t version) {
    std::lock_guard<std::mutex> lk(m_);
    for (const auto& q : queue_)
        if (q.changesRecipe && q.recipeVersion > version) return true;
    return false;
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
        runningChangesRecipe_ = p.changesRecipe;
        runningVersion_ = p.recipeVersion;
    }
    try {
        execute(p);
    } catch (...) {
        sendError(Json(static_cast<long long>(p.id)), err::kInternal,
                  "Command \"" + p.type + "\" failed inside the engine: " + describeCurrentException(), version_);
    }
    {
        std::lock_guard<std::mutex> lk(m_);
        runningId_ = 0;
        runningChangesRecipe_ = false;
        runningVersion_ = -1;
        if (cancelTarget_ == p.id) cancelTarget_ = 0;
        if (supersededTarget_ == p.id) supersededTarget_ = 0;
    }
    return true;
}

void Engine::execute(Pending& p) {
    const Json idJson(static_cast<long long>(p.id));
    const Json& m = p.msg;

    if (p.type == "loadRecipe" || p.type == "setParameter") {
        if (p.recipeVersion <= version_) {
            sendError(idJson, err::kStaleVersion,
                      "recipeVersion " + std::to_string(p.recipeVersion) + " is not newer than the engine's current version " +
                          std::to_string(version_.load()) + "; the command was ignored.",
                      p.recipeVersion);
            return;
        }
        if (p.type == "loadRecipe") {
            const Json* r = m.find("recipe");
            if (!r) {
                sendError(idJson, err::kBadMessage, "Command \"loadRecipe\" needs the field \"recipe\".", p.recipeVersion);
                return;
            }
            try {
                recipe_ = parseRecipe(*r, opt_.debugCommands);
            } catch (const RecipeError& e) {
                sendError(idJson, err::kBadRecipe, std::string("The recipe cannot be used: ") + e.what(), p.recipeVersion);
                return;
            }
            hasRecipe_ = true;
        } else {
            if (!hasRecipe_) {
                sendError(idJson, err::kNoRecipe, "Command \"setParameter\" needs a recipe; send \"loadRecipe\" first.", p.recipeVersion);
                return;
            }
            const Json* name = m.find("name");
            const Json* value = m.find("value");
            if (!name || !name->isString() || !value || !value->isNumber() || !std::isfinite(value->number())) {
                sendError(idJson, err::kBadMessage, "Command \"setParameter\" needs \"name\" (string) and \"value\" (finite number).", p.recipeVersion);
                return;
            }
            auto it = recipe_.params.find(name->str());
            if (it == recipe_.params.end()) {
                std::string known;
                for (const auto& kv : recipe_.params) known += (known.empty() ? "" : ", ") + kv.first;
                sendError(idJson, err::kUnknownParameter,
                          "The recipe has no parameter \"" + name->str() + "\". Known parameters: " + (known.empty() ? "none" : known) + ".",
                          p.recipeVersion);
                return;
            }
            it->second = value->number();
        }
        version_ = p.recipeVersion;
        // Cancelling never reverts a recipe change: the change is kept, only the rebuild is skipped.
        if (p.cancelledWhileQueued) {
            sendError(idJson, err::kCancelled,
                      "The rebuild of recipe version " + std::to_string(p.recipeVersion) + " was cancelled before it started; the change itself is kept.",
                      p.recipeVersion);
            return;
        }
        if (newerRecipeChangeQueued(p.recipeVersion)) {
            sendError(idJson, err::kSuperseded,
                      "The rebuild of recipe version " + std::to_string(p.recipeVersion) + " was skipped because a newer version is already queued.",
                      p.recipeVersion);
            return;
        }
        rebuildAndReply(p);
        return;
    }

    if (p.cancelledWhileQueued) {
        sendError(idJson, err::kCancelled, "Command \"" + p.type + "\" was cancelled before it started.", version_);
        return;
    }

    if (p.type == "shutdown") {
        sendJson(base("bye", p.id, version_));
        stop_ = true;
        cv_.notify_all();
        return;
    }

    if (p.type == "debugPayload") {
        const Json* b = m.find("bytes");
        if (!b || !b->isNumber() || b->number() < 0 || b->number() > protocol::kMaxPayloadBytes || b->number() != std::floor(b->number())) {
            sendError(idJson, err::kBadMessage, "Command \"debugPayload\" needs \"bytes\", an integer from 0 to 1073741824.", version_);
            return;
        }
        const auto t0 = Clock::now();
        std::vector<uint8_t> payload(static_cast<size_t>(b->number()));
        for (size_t i = 0; i < payload.size(); ++i) payload[i] = static_cast<uint8_t>((i * 31) & 255);
        const uint32_t h = fnv1a32(payload.data(), payload.size());
        Json j = base("debugPayloadResult", p.id, version_);
        j["bytes"] = static_cast<unsigned long long>(payload.size());
        j["fnv1a"] = h;
        j["fillMs"] = msSince(t0);
        sendJson(j, &payload);
        return;
    }

    if (p.type == "debugCrash") {
        const Json* mode = m.find("mode");
        const std::string md = mode && mode->isString() ? mode->str() : "";
        std::fprintf(stderr, "halfcube-engine: debugCrash \"%s\" requested by command %lld\n", md.c_str(), static_cast<long long>(p.id));
        std::fflush(stderr);
        if (md == "abort") std::abort();
        if (md == "nullcall") { const int r = gNullFn(1); std::fprintf(stderr, "nullcall returned %d\n", r); }
        if (md == "intdiv") { const int q = 7 / gZero; std::fprintf(stderr, "intdiv returned %d\n", q); }
        sendError(idJson, err::kBadMessage,
                  md == "abort" || md == "nullcall" || md == "intdiv"
                      ? "debugCrash \"" + md + "\" did not crash the engine on this platform."
                      : "Command \"debugCrash\" needs \"mode\": \"abort\", \"nullcall\" or \"intdiv\".",
                  version_);
        return;
    }
}

void Engine::rebuildAndReply(const Pending& p) {
    const Json idJson(static_cast<long long>(p.id));
    const int64_t id = p.id;
    const Model::CancelFn cancelled = [this, id] { return isCancelled(id); };
    const auto tStart = Clock::now();
    const size_t stepCount = recipe_.steps.size();
    try {
        RebuildOut ro = model_.rebuild(recipe_, cancelled, [&](size_t i, const StepStatus& st) {
            Json ev = base("progress", id, p.recipeVersion);
            ev["stage"] = "step";
            ev["stepIndex"] = static_cast<unsigned long long>(i);
            ev["stepCount"] = static_cast<unsigned long long>(stepCount);
            ev["stepId"] = st.stepId;
            ev["step"] = st.toJson();
            sendJson(ev);
        });
        const double rebuildMs = msSince(tStart);

        Json ev = base("progress", id, p.recipeVersion);
        ev["stage"] = "mesh";
        ev["stepIndex"] = -1;
        ev["stepCount"] = static_cast<unsigned long long>(stepCount);
        ev["stepId"] = Json();
        sendJson(ev);

        std::vector<uint8_t> payload;
        Json bodies = Json::array();
        double meshMs = 0, encodeMs = 0;
        std::map<std::string, MeshCacheEntry> nextCache;
        for (const auto& b : ro.bodies) {
            auto it = meshCache_.find(b.bodyId);
            MeshCacheEntry entry;
            if (it != meshCache_.end() && it->second.key == b.key) {
                entry = it->second;
            } else {
                entry.key = b.key;
                entry.block = meshBody(b, meshParams_, cancelled);
                meshMs += entry.block.meshMs;
                encodeMs += entry.block.encodeMs;
            }
            const auto t0 = Clock::now();
            bodies.push(appendBlock(entry.block, payload));
            encodeMs += msSince(t0);
            nextCache[b.bodyId] = std::move(entry);
        }
        meshCache_ = std::move(nextCache);

        Json steps = Json::array();
        for (const auto& s : ro.steps) steps.push(s.toJson());
        Json j = base("result", id, p.recipeVersion);
        j["outcome"] = ro.outcome;
        j["steps"] = steps;
        j["bodies"] = bodies;
        Json t = Json::object();
        t["rebuildMs"] = rebuildMs;
        t["meshMs"] = meshMs;
        t["encodeMs"] = encodeMs;
        t["totalMs"] = msSince(tStart);
        j["timings"] = t;
        j["payloadBytes"] = static_cast<unsigned long long>(payload.size());
        Json tess = Json::object();
        tess["deflection"] = meshParams_.deflection;
        tess["angleDeg"] = meshParams_.angleDeg;
        j["tessellation"] = tess;
        sendJson(j, &payload);
    } catch (const Cancelled&) {
        if (supersededTarget_.load() == id) {
            sendError(idJson, err::kSuperseded,
                      "The rebuild of recipe version " + std::to_string(p.recipeVersion) + " was stopped because version " +
                          std::to_string(supersededBy_.load()) + " arrived while it was running.",
                      p.recipeVersion);
        } else {
            sendError(idJson, err::kCancelled,
                      "The rebuild of recipe version " + std::to_string(p.recipeVersion) + " was cancelled after " +
                          std::to_string(static_cast<long long>(msSince(tStart))) + " ms; the recipe change itself is kept.",
                      p.recipeVersion);
        }
    }
}

} // namespace hc
