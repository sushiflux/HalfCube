// Native engine process: protocol frames on stdin/stdout (layout in core/frame.hpp), diagnostics on stderr.
//
//   halfcube-engine
//
// Only the parent process holds the pipe ends, so no other process or user can reach the engine; there is no
// network port. A reader thread answers hello, ping and cancel at once while the main thread computes.
// Exit codes: 0 after "shutdown" or at the end of the input, 2 when the input is not a valid frame stream,
// 64 for unknown command-line arguments. Hardware faults (access violation, integer division by zero) are not
// turned into exceptions: the process ends and the desktop supervisor restarts it.

#include "core/engine.hpp"
#include "core/frame.hpp"

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
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
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

// Reads exactly n bytes. Returns false at the end of the input (or on a read error) before n bytes arrived.
bool readAll(int fd, std::uint8_t* p, std::size_t n) {
    while (n > 0) {
        const unsigned chunk = static_cast<unsigned>(std::min<std::size_t>(n, 1u << 20));
        const int r = sysRead(fd, p, chunk);
        if (r <= 0) return false;
        p += r;
        n -= static_cast<std::size_t>(r);
    }
    return true;
}

bool writeAll(int fd, const std::uint8_t* p, std::size_t n) {
    while (n > 0) {
        const unsigned chunk = static_cast<unsigned>(std::min<std::size_t>(n, 1u << 20));
        const int w = sysWrite(fd, p, chunk);
        if (w <= 0) return false;
        p += w;
        n -= static_cast<std::size_t>(w);
    }
    return true;
}

class FrameOutput : public hc::Output {
public:
    explicit FrameOutput(int fd) : fd_(fd) {}

    void send(const std::string& header, const std::vector<std::uint8_t>* payload) override {
        const std::size_t payloadBytes = payload ? payload->size() : 0;
        const auto prefix = hc::frame::encodePrefix(static_cast<std::uint32_t>(header.size()), static_cast<std::uint32_t>(payloadBytes));
        std::lock_guard<std::mutex> lk(m_);
        const bool ok = writeAll(fd_, prefix.data(), prefix.size()) &&
                        writeAll(fd_, reinterpret_cast<const std::uint8_t*>(header.data()), header.size()) &&
                        (payloadBytes == 0 || writeAll(fd_, payload->data(), payloadBytes));
        if (!ok) {
            // The parent closed the pipe: nobody is listening any more.
            std::fprintf(stderr, "halfcube-engine: writing to the parent process failed, exiting\n");
            std::fflush(stderr);
            std::_Exit(0);
        }
    }

private:
    int fd_;
    std::mutex m_;
};

} // namespace

int main(int argc, char** argv) {
    if (argc > 1) {
        std::fprintf(stderr, "halfcube-engine: unknown argument \"%s\"\nusage: halfcube-engine (frames on stdin/stdout)\n", argv[1]);
        return 64;
    }

#ifdef _WIN32
    // No Windows error dialogs when the engine crashes: the parent sees the exit and restarts it.
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
    _setmode(0, _O_BINARY);
    // Frames go to a private copy of stdout; fd 1 is pointed at stderr so stray library output cannot corrupt the
    // frame stream.
    const int frameFd = _dup(1);
    _setmode(frameFd, _O_BINARY);
    _dup2(2, 1);
#else
    const int frameFd = ::dup(1);
    ::dup2(2, 1);
#endif

    FrameOutput out(frameFd);
    hc::EngineOptions options;
    options.pingWhileBusy = true;
    options.cancelWhileBusy = true;
    hc::Engine engine(out, options);

    std::thread reader([&engine] {
        std::vector<std::uint8_t> header, payload;
        for (;;) {
            std::uint8_t prefixBytes[hc::frame::kPrefixBytes];
            if (!readAll(0, prefixBytes, sizeof prefixBytes)) break;  // end of input: the parent closed stdin or is gone
            const hc::frame::Prefix prefix = hc::frame::decodePrefix(prefixBytes);
            const std::string problem = hc::frame::checkPrefix(prefix);
            if (!problem.empty()) {
                std::fprintf(stderr, "halfcube-engine: the input is not a valid frame stream (%s), exiting\n", problem.c_str());
                std::fflush(stderr);
                std::_Exit(2);
            }
            header.resize(prefix.headerBytes);
            payload.resize(prefix.payloadBytes);
            if (!readAll(0, header.data(), header.size()) || !readAll(0, payload.data(), payload.size())) break;
            engine.receive(std::string_view(reinterpret_cast<const char*>(header.data()), header.size()), payload);
        }
        engine.requestStop();
    });
    reader.detach();

    while (!engine.stopped()) engine.runNext(true);
    std::fflush(stderr);
    // The reader thread may still block in read(); end without running static destructors.
    std::_Exit(0);
}
