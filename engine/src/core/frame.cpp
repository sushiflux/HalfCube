#include "core/frame.hpp"

#include "generated/protocol.hpp"

#include <cstdio>
#include <stdexcept>

namespace pc::frame {

namespace {

void putU32(std::uint8_t* p, std::uint32_t v) {
    p[0] = static_cast<std::uint8_t>(v);
    p[1] = static_cast<std::uint8_t>(v >> 8);
    p[2] = static_cast<std::uint8_t>(v >> 16);
    p[3] = static_cast<std::uint8_t>(v >> 24);
}

std::uint32_t getU32(const std::uint8_t* p) {
    return static_cast<std::uint32_t>(p[0]) | static_cast<std::uint32_t>(p[1]) << 8 |
           static_cast<std::uint32_t>(p[2]) << 16 | static_cast<std::uint32_t>(p[3]) << 24;
}

static_assert(kPrefixBytes == protocol::kFramePrefixBytes, "frame prefix size differs from the protocol definition");

} // namespace

std::array<std::uint8_t, kPrefixBytes> encodePrefix(std::uint32_t headerBytes, std::uint32_t payloadBytes) {
    std::array<std::uint8_t, kPrefixBytes> out{};
    putU32(out.data(), protocol::kFrameMagic);
    putU32(out.data() + 4, headerBytes);
    putU32(out.data() + 8, payloadBytes);
    putU32(out.data() + 12, 0);
    return out;
}

Prefix decodePrefix(const std::uint8_t* bytes) {
    return Prefix{getU32(bytes), getU32(bytes + 4), getU32(bytes + 8), getU32(bytes + 12)};
}

std::string checkPrefix(const Prefix& p) {
    char buf[200];
    if (p.magic != protocol::kFrameMagic) {
        std::snprintf(buf, sizeof buf, "frame magic is 0x%08x instead of 0x%08x (\"PCE1\")", static_cast<unsigned>(p.magic),
                      static_cast<unsigned>(protocol::kFrameMagic));
        return buf;
    }
    if (p.headerBytes > protocol::kMaxHeaderBytes) {
        std::snprintf(buf, sizeof buf, "frame header of %u bytes exceeds the limit of %u bytes", static_cast<unsigned>(p.headerBytes),
                      static_cast<unsigned>(protocol::kMaxHeaderBytes));
        return buf;
    }
    if (p.payloadBytes > protocol::kMaxPayloadBytes) {
        std::snprintf(buf, sizeof buf, "frame payload of %u bytes exceeds the limit of %u bytes", static_cast<unsigned>(p.payloadBytes),
                      static_cast<unsigned>(protocol::kMaxPayloadBytes));
        return buf;
    }
    if (p.reserved != 0) {
        std::snprintf(buf, sizeof buf, "reserved frame field is %u instead of 0", static_cast<unsigned>(p.reserved));
        return buf;
    }
    return {};
}

std::vector<std::uint8_t> encode(std::string_view header, const std::vector<std::uint8_t>* payload) {
    const std::size_t payloadBytes = payload ? payload->size() : 0;
    if (header.size() > protocol::kMaxHeaderBytes || payloadBytes > protocol::kMaxPayloadBytes)
        throw std::length_error("frame header or payload exceeds the protocol limits");
    const auto prefix = encodePrefix(static_cast<std::uint32_t>(header.size()), static_cast<std::uint32_t>(payloadBytes));
    std::vector<std::uint8_t> out;
    out.reserve(kPrefixBytes + header.size() + payloadBytes);
    out.insert(out.end(), prefix.begin(), prefix.end());
    out.insert(out.end(), header.begin(), header.end());
    if (payload) out.insert(out.end(), payload->begin(), payload->end());
    return out;
}

} // namespace pc::frame
