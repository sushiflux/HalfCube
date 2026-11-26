// Binary payload of an engine answer: typed arrays one after the other, each starting at a multiple of
// payloadAlignment from the payload start (little-endian, as both targets are).
#pragma once

#include "generated/protocol.hpp"

#include <bit>
#include <cstdint>
#include <cstring>
#include <vector>

namespace hc::model {

static_assert(std::endian::native == std::endian::little, "the payload encoding assumes a little-endian target");

inline std::size_t alignUp(std::size_t n) {
    const std::size_t a = protocol::kPayloadAlignment;
    return (n + a - 1) / a * a;
}

class PayloadWriter {
public:
    // Appends the elements of v at the next aligned offset and returns where they are.
    template <class T>
    protocol::BufferRef add(const std::vector<T>& v) {
        protocol::BufferRef ref;
        const std::size_t offset = alignUp(bytes_.size());
        const std::size_t length = v.size() * sizeof(T);
        bytes_.resize(offset + length);
        if (length) std::memcpy(bytes_.data() + offset, v.data(), length);
        ref.offset = static_cast<std::int64_t>(offset);
        ref.byteLength = static_cast<std::int64_t>(length);
        return ref;
    }

    // Appends a block whose buffer offsets are relative to its own start; returns the shift to add to them.
    std::int64_t addBlock(const std::vector<std::uint8_t>& block) {
        const std::size_t offset = alignUp(bytes_.size());
        bytes_.resize(offset + block.size());
        if (!block.empty()) std::memcpy(bytes_.data() + offset, block.data(), block.size());
        return static_cast<std::int64_t>(offset);
    }

    std::vector<std::uint8_t>& bytes() {
        bytes_.resize(alignUp(bytes_.size()));
        return bytes_;
    }

private:
    std::vector<std::uint8_t> bytes_;
};

} // namespace hc::model
