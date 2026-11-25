// Stdio frame format of the native transport (layout in protocol::kFramePrefixBytes' description):
//   u32 magic "PCE1", u32 header bytes, u32 payload bytes, u32 reserved (0), header (UTF-8 JSON), payload.
// All integers little-endian, independent of the host byte order.
#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace pc::frame {

struct Prefix {
    std::uint32_t magic = 0;
    std::uint32_t headerBytes = 0;
    std::uint32_t payloadBytes = 0;
    std::uint32_t reserved = 0;
};

inline constexpr std::size_t kPrefixBytes = 16;

std::array<std::uint8_t, kPrefixBytes> encodePrefix(std::uint32_t headerBytes, std::uint32_t payloadBytes);
Prefix decodePrefix(const std::uint8_t* bytes);

// Empty when the prefix may be followed; otherwise the complete reason why the stream is broken.
std::string checkPrefix(const Prefix& prefix);

// Whole frame in one buffer (tests and small messages).
std::vector<std::uint8_t> encode(std::string_view header, const std::vector<std::uint8_t>* payload);

} // namespace pc::frame
