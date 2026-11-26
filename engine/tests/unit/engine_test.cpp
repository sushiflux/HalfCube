#include "core/engine.hpp"
#include "partcraft/build_info.hpp"

#include <doctest/doctest.h>

#include <string>
#include <vector>

using namespace pc;

namespace {

class CaptureOutput : public Output {
public:
    void send(const std::string& header, const std::vector<std::uint8_t>*) override { messages.push_back(Json::parse(header)); }
    std::vector<Json> messages;
};

void send(Engine& e, const Json& j) {
    e.receive(j.dump(), {});
    while (e.runNext(false)) {
    }
}

Json last(const CaptureOutput& out) {
    REQUIRE_FALSE(out.messages.empty());
    return out.messages.back();
}

void hello(Engine& e) { send(e, Json{{"type", "hello"}, {"id", 1}, {"protocol", protocol::kVersion}, {"protocolId", protocol::kProtocolId}, {"client", "unit test"}}); }

} // namespace

TEST_CASE("hello answers with versions and build facts") {
    CaptureOutput out;
    Engine e(out, EngineOptions{});
    hello(e);
    const Json r = last(out);
    CHECK(r["type"] == "helloResult");
    CHECK(r["replyTo"] == 1);
    CHECK(r["protocol"] == protocol::kVersion);
    CHECK(r["protocolId"] == std::string(protocol::kProtocolId));
    CHECK(r["engine"]["name"] == "partcraft-engine");
    CHECK(r["engine"]["platform"] == "native");
    CHECK(r["components"]["occt"] == "8.0.2");
    CHECK(r["components"]["planegcs"]["source"] == "FreeCAD 1.1.4");
    CHECK(r["components"]["planegcs"]["commit"] == "4fd3bf320d9566a27e60069fc8387448aaa3a094");
    CHECK(r["components"]["eigen"] == "3.4.0");
    CHECK(r["components"]["boost"] == "1.92.0");
    CHECK(r["components"]["nlohmannJson"] == "3.12.0");
    CHECK(r["engine"]["testCommands"] == build::kTestCommands);
}

TEST_CASE("commands before hello are refused") {
    CaptureOutput out;
    Engine e(out, EngineOptions{});
    send(e, Json{{"type", "ping"}, {"id", 4}});
    CHECK(last(out)["type"] == "error");
    CHECK(last(out)["code"] == "not_initialized");
    CHECK(last(out)["replyTo"] == 4);
}

TEST_CASE("a different protocol version is refused") {
    CaptureOutput out;
    Engine e(out, EngineOptions{});
    send(e, Json{{"type", "hello"}, {"id", 1}, {"protocol", 99}, {"client", "old ui"}});
    CHECK(last(out)["code"] == "protocol_mismatch");
    CHECK(last(out)["message"].get<std::string>().find("asked for version 99") != std::string::npos);
}

TEST_CASE("a different or missing protocol id is refused with both values named") {
    const std::string version = std::to_string(protocol::kVersion);
    {
        CaptureOutput out;
        Engine e(out, EngineOptions{});
        send(e, Json{{"type", "hello"}, {"id", 1}, {"protocol", protocol::kVersion}, {"protocolId", "0123456789abcdef"}, {"client", "other ui"}});
        CHECK(last(out)["code"] == "protocol_mismatch");
        const std::string text = last(out)["message"].get<std::string>();
        CHECK(text.find("The engine speaks protocol \"" + std::string(protocol::kProtocolId) + "\" (version " + version + ")") != std::string::npos);
        CHECK(text.find("named protocol \"0123456789abcdef\" (version " + version + ")") != std::string::npos);
        // The handshake was not accepted: other commands stay refused.
        send(e, Json{{"type", "ping"}, {"id", 2}});
        CHECK(last(out)["code"] == "not_initialized");
    }
    {
        CaptureOutput out;
        Engine e(out, EngineOptions{});
        send(e, Json{{"type", "hello"}, {"id", 1}, {"protocol", protocol::kVersion}, {"client", "no id"}});
        CHECK(last(out)["code"] == "protocol_mismatch");
        CHECK(last(out)["message"].get<std::string>().find("named protocol nothing (no protocolId in hello)") != std::string::npos);
    }
}

TEST_CASE("malformed messages get specific errors") {
    CaptureOutput out;
    Engine e(out, EngineOptions{});
    e.receive("{not json", {});
    CHECK(last(out)["code"] == "bad_message");
    CHECK(last(out)["replyTo"].is_null());
    e.receive("[1,2]", {});
    CHECK(last(out)["code"] == "bad_message");
    send(e, Json{{"type", "ping"}, {"id", 0}});
    CHECK(last(out)["message"] == "The message field \"id\" must be an integer from 1 to 2147483647, got 0.");
    hello(e);
    send(e, Json{{"type", "nope"}, {"id", 3}});
    CHECK(last(out)["code"] == "unknown_command");
    send(e, Json{{"type", "ping"}, {"id", 5}, {"extra", true}});
    CHECK(last(out)["code"] == "bad_message");
    CHECK(last(out)["message"] == "Command \"ping\" has no field \"extra\" (it takes no fields).");
    send(e, Json{{"type", "cancel"}, {"id", 6}});
    CHECK(last(out)["message"] == "Command \"cancel\": field \"target\" is missing.");
    send(e, Json{{"type", "diagnostics.hang"}, {"id", 7}, {"mode", "sleepy"}});
    if (build::kTestCommands) {
        CHECK(last(out)["message"] == "Command \"diagnostics.hang\": field \"mode\" must be one of \"busy\", \"frozen\", got \"sleepy\".");
        send(e, Json{{"type", "diagnostics.hang"}, {"id", 8}, {"mode", "busy"}, {"ms", 5}});
        CHECK(last(out)["type"] == "hangResult");
        CHECK(last(out)["ms"].get<double>() >= 5.0);
    } else {
        CHECK(last(out)["code"] == "test_commands_disabled");
    }
    e.receive(Json{{"type", "ping"}, {"id", 9}}.dump(), std::vector<std::uint8_t>{1, 2});
    CHECK(last(out)["message"] == "Command \"ping\" takes no binary payload, but 2 bytes arrived.");
}

TEST_CASE("ping, cancel of a queued command and shutdown") {
    CaptureOutput out;
    Engine e(out, EngineOptions{});
    hello(e);
    e.receive(Json{{"type", "ping"}, {"id", 2}}.dump(), {});
    CHECK(last(out)["type"] == "pong");
    CHECK(last(out)["busyWith"].is_null());
    CHECK(last(out)["queued"] == 0);
    e.receive(Json{{"type", "diagnostics.solverSelftest"}, {"id", 3}}.dump(), {});
    e.receive(Json{{"type", "cancel"}, {"id", 4}, {"target", 3}}.dump(), {});
    CHECK(last(out)["type"] == "cancelResult");
    CHECK(last(out)["state"] == "queued");
    e.receive(Json{{"type", "cancel"}, {"id", 5}, {"target", 77}}.dump(), {});
    CHECK(last(out)["state"] == "notFound");
    CHECK(e.runNext(false));
    CHECK(last(out)["type"] == "error");
    CHECK(last(out)["code"] == "cancelled");
    CHECK(last(out)["replyTo"] == 3);
    send(e, Json{{"type", "shutdown"}, {"id", 6}});
    CHECK(last(out)["type"] == "bye");
    CHECK(e.stopped());
}

TEST_CASE("self-tests answer through the engine") {
    CaptureOutput out;
    Engine e(out, EngineOptions{});
    hello(e);
    send(e, Json{{"type", "diagnostics.kernelSelftest"}, {"id", 2}});
    CHECK(last(out)["type"] == "kernelSelftestResult");
    CHECK(last(out)["passed"] == true);
    send(e, Json{{"type", "diagnostics.solverSelftest"}, {"id", 3}});
    CHECK(last(out)["type"] == "solverSelftestResult");
    CHECK(last(out)["passed"] == true);
    CHECK(last(out)["algorithm"] == "DogLeg");
}
