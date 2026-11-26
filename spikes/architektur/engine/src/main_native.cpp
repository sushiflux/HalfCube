// Native engine process: protocol frames on stdin/stdout (layout in protocol.hpp), diagnostics on stderr.
//
//   halfcube-engine [--debug-commands]
//
// Only the parent process holds the pipe ends, so no other process or user can reach the engine; there is no
// network port. A reader thread answers ping and cancel at once while the main thread computes.
// Exit codes: 0 after "shutdown" or end of input, 2 when the input stream is not a valid frame stream.
// Hardware faults (access violation, integer division by zero) are not turned into exceptions: the process
// ends and the parent restarts it and replays the recipe.

#include "engine.hpp"
#include "protocol.hpp"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace {

#ifdef _WIN32
int sysRead(int fd, void* buf, unsigned n) { return _read(fd, buf, n); }
int sysWrite(int fd, const void* buf, unsigned n) { return _write(fd, buf, n); }
#else
int sysRead(int fd, void* buf, unsigned n) { return static_cast<int>(::read(fd, buf, n)); }
int sysWrite(int fd, const void* buf, unsigned n) { return static_cast<int>(::write(fd, buf, n)); }
#endif

// Reads exactly n bytes. Returns false on end of input (or a read error) before n bytes arrived.
bool readAll(int fd, uint8_t* p, size_t n) {
    while (n > 0) {
        const unsigned chunk = static_cast<unsigned>(std::min<size_t>(n, 1u << 20));
        const int r = sysRead(fd, p, chunk);
        if (r <= 0) return false;
        p += r;
        n -= static_cast<size_t>(r);
    }
    return true;
}

bool writeAll(int fd, const uint8_t* p, size_t n) {
    while (n > 0) {
        const unsigned chunk = static_cast<unsigned>(std::min<size_t>(n, 1u << 20));
        const int w = sysWrite(fd, p, chunk);
        if (w <= 0) return false;
        p += w;
        n -= static_cast<size_t>(w);
    }
    return true;
}

void putU32(uint8_t* p, uint32_t v) {
    p[0] = uint8_t(v); p[1] = uint8_t(v >> 8); p[2] = uint8_t(v >> 16); p[3] = uint8_t(v >> 24);
}
uint32_t getU32(const uint8_t* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }

class FrameOutput : public hc::Output {
public:
    explicit FrameOutput(int fd) : fd_(fd) {}
    void send(const std::string& header, const std::vector<uint8_t>* payload) override {
        uint8_t prefix[hc::protocol::kFramePrefixBytes];
        putU32(prefix, hc::protocol::kFrameMagic);
        putU32(prefix + 4, static_cast<uint32_t>(header.size()));
        putU32(prefix + 8, payload ? static_cast<uint32_t>(payload->size()) : 0u);
        putU32(prefix + 12, 0);
        std::lock_guard<std::mutex> lk(m_);
        const bool ok = writeAll(fd_, prefix, sizeof prefix) &&
                        writeAll(fd_, reinterpret_cast<const uint8_t*>(header.data()), header.size()) &&
                        (!payload || payload->empty() || writeAll(fd_, payload->data(), payload->size()));
        if (!ok) {
            // The parent closed the pipe: nobody is listening any more.
            std::fprintf(stderr, "halfcube-engine: writing to the parent failed, exiting\n");
            std::_Exit(0);
        }
    }

private:
    int fd_;
    std::mutex m_;
};

} // namespace

int main(int argc, char** argv) {
    bool debug = false;
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--debug-commands") == 0) debug = true;
        else {
            std::fprintf(stderr, "halfcube-engine: unknown argument \"%s\"\nusage: halfcube-engine [--debug-commands]\n", argv[i]);
            return 64;
        }
    }

#ifdef _WIN32
    // No Windows error dialogs when the engine crashes: the parent sees the exit and restarts it.
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
    _setmode(0, _O_BINARY);
    // Frames go to a private copy of stdout; fd 1 is pointed at stderr so stray library output cannot
    // corrupt the frame stream.
    const int frameFd = _dup(1);
    _setmode(frameFd, _O_BINARY);
    _dup2(2, 1);
    const char* platform = "windows-x64";
#else
    const int frameFd = ::dup(1);
    ::dup2(2, 1);
    const char* platform = "linux-x64";
#endif

    FrameOutput out(frameFd);
    hc::EngineOptions opt;
    opt.debugCommands = debug;
    opt.platform = platform;
    opt.pingWhileBusy = true;
    opt.cancelWhileBusy = true;
    hc::Engine engine(out, opt);

    std::thread reader([&engine] {
        std::vector<uint8_t> header, payload;
        for (;;) {
            uint8_t prefix[hc::protocol::kFramePrefixBytes];
            if (!readAll(0, prefix, sizeof prefix)) break;  // end of input: the parent is gone or closed stdin
            const uint32_t magic = getU32(prefix), hLen = getU32(prefix + 4), pLen = getU32(prefix + 8);
            if (magic != hc::protocol::kFrameMagic || hLen > hc::protocol::kMaxHeaderBytes || pLen > hc::protocol::kMaxPayloadBytes) {
                std::fprintf(stderr, "halfcube-engine: broken frame stream (magic 0x%08x, header %u bytes, payload %u bytes), exiting\n",
                             magic, hLen, pLen);
                std::fflush(stderr);
                std::_Exit(2);
            }
            header.resize(hLen);
            payload.resize(pLen);
            if (!readAll(0, header.data(), hLen) || !readAll(0, payload.data(), pLen)) break;
            engine.receive(std::string_view(reinterpret_cast<const char*>(header.data()), header.size()), payload);
        }
        engine.requestStop();
    });
    reader.detach();

    while (!engine.stopped()) engine.runNext(true);
    std::fflush(stderr);
    // The reader thread may still block in read(); end the process without running static destructors.
    std::_Exit(0);
}
