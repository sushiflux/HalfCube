// Engine message protocol v0: constants shared by the native and the WebAssembly engine.
// The message shapes are defined in protocol.ts (TypeScript types) and protocol.schema.json (JSON Schema);
// this header holds the numbers and names the C++ side needs. Keep all three in step; the contract tests
// validate every engine message against the schema.
#pragma once

#include <cstdint>

namespace pc::protocol {

// Compared in the hello handshake; any other value is refused with error "protocol_mismatch".
inline constexpr int kVersion = 0;

// Stdio frame (native transport only), all integers little-endian:
//   offset 0  u32 magic "PCE0"
//   offset 4  u32 header length in bytes (UTF-8 JSON text)
//   offset 8  u32 payload length in bytes (binary, may be 0)
//   offset 12 u32 reserved, must be 0
//   offset 16 header, then payload
inline constexpr uint32_t kFrameMagic = 0x30454350u;  // bytes 'P' 'C' 'E' '0'
inline constexpr uint32_t kFramePrefixBytes = 16;
inline constexpr uint32_t kMaxHeaderBytes = 16u * 1024 * 1024;
inline constexpr uint32_t kMaxPayloadBytes = 1024u * 1024 * 1024;

// Every buffer inside a payload starts at a multiple of this (relative to the payload start).
inline constexpr uint32_t kPayloadAlignment = 16;

// Request ids are positive and fit into an int32 (the WebAssembly cancel flag is an Int32Array slot).
inline constexpr int64_t kMaxRequestId = 2147483647;

namespace err {
inline constexpr const char* kProtocolMismatch = "protocol_mismatch";
inline constexpr const char* kNotInitialized = "not_initialized";
inline constexpr const char* kBadMessage = "bad_message";
inline constexpr const char* kUnknownCommand = "unknown_command";
inline constexpr const char* kBadRecipe = "bad_recipe";
inline constexpr const char* kNoRecipe = "no_recipe";
inline constexpr const char* kUnknownParameter = "unknown_parameter";
inline constexpr const char* kStaleVersion = "stale_version";
inline constexpr const char* kCancelled = "cancelled";
inline constexpr const char* kSuperseded = "superseded";
inline constexpr const char* kDebugDisabled = "debug_disabled";
inline constexpr const char* kInternal = "internal";
} // namespace err

} // namespace pc::protocol
