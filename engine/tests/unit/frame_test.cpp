#include "core/frame.hpp"
#include "generated/protocol.hpp"

#include <doctest/doctest.h>

#include <string>

using namespace hc;

TEST_CASE("frame prefix is little-endian with magic HCE1") {
    const auto p = frame::encodePrefix(5, 300);
    CHECK(p[0] == 'H');
    CHECK(p[1] == 'C');
    CHECK(p[2] == 'E');
    CHECK(p[3] == '1');
    CHECK(p[4] == 5);
    CHECK(p[8] == 300 % 256);
    CHECK(p[9] == 1);
    const frame::Prefix d = frame::decodePrefix(p.data());
    CHECK(d.magic == protocol::kFrameMagic);
    CHECK(d.headerBytes == 5);
    CHECK(d.payloadBytes == 300);
    CHECK(d.reserved == 0);
    CHECK(frame::checkPrefix(d).empty());
}

TEST_CASE("whole frame holds prefix, header and payload") {
    const std::vector<std::uint8_t> payload = {1, 2, 3};
    const auto f = frame::encode("{\"a\":1}", &payload);
    REQUIRE(f.size() == 16 + 7 + 3);
    CHECK(std::string(f.begin() + 16, f.begin() + 23) == "{\"a\":1}");
    CHECK(f.back() == 3);
}

TEST_CASE("broken prefixes are named") {
    frame::Prefix p{0x12345678u, 1, 0, 0};
    CHECK(frame::checkPrefix(p).find("magic") != std::string::npos);
    p = frame::Prefix{protocol::kFrameMagic, protocol::kMaxHeaderBytes + 1, 0, 0};
    CHECK(frame::checkPrefix(p).find("header") != std::string::npos);
    p = frame::Prefix{protocol::kFrameMagic, 1, protocol::kMaxPayloadBytes + 1, 0};
    CHECK(frame::checkPrefix(p).find("payload") != std::string::npos);
    p = frame::Prefix{protocol::kFrameMagic, 1, 0, 7};
    CHECK(frame::checkPrefix(p).find("reserved") != std::string::npos);
}
