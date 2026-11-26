// Minimal stand-in for FreeCAD's Base/Console.h, which planegcs includes in GCS.cpp only to log
// text. FreeCAD's real Console (src/Base/Console.h) is a singleton bound to FreeCAD's application
// framework; planegcs only calls Base::Console().log(...) and Base::Console().warning(...) with
// printf-style arguments. This shim formats the text and either drops it or appends it to a
// capture buffer that the test driver installs (used to count solver iterations, which planegcs
// only reports through this log when debugMode == IterationLevel).
#ifndef HALFCUBE_SOLVERTEST_SHIM_BASE_CONSOLE_H
#define HALFCUBE_SOLVERTEST_SHIM_BASE_CONSOLE_H

#include <cstdio>
#include <string>
#include <vector>

namespace Base
{

class ConsoleShim
{
public:
    // When set, every message is appended here; otherwise messages are dropped.
    std::string* capture = nullptr;
    // When true, warnings and errors are also written to stderr.
    bool echoWarnings = false;

    template<typename... Args>
    void log(const char* fmt, Args... args)
    {
        if (capture) {
            append(*capture, fmt, args...);
        }
    }

    template<typename... Args>
    void warning(const char* fmt, Args... args)
    {
        emitWarning("warning: ", fmt, args...);
    }

    template<typename... Args>
    void error(const char* fmt, Args... args)
    {
        emitWarning("error: ", fmt, args...);
    }

    template<typename... Args>
    void message(const char* fmt, Args... args)
    {
        log(fmt, args...);
    }

private:
    template<typename... Args>
    static void append(std::string& out, const char* fmt, Args... args)
    {
        if constexpr (sizeof...(Args) == 0) {
            out += fmt;
        }
        else {
            int n = std::snprintf(nullptr, 0, fmt, args...);
            if (n <= 0) {
                return;
            }
            std::vector<char> buf(static_cast<size_t>(n) + 1);
            std::snprintf(buf.data(), buf.size(), fmt, args...);
            out.append(buf.data(), static_cast<size_t>(n));
        }
    }

    template<typename... Args>
    void emitWarning(const char* prefix, const char* fmt, Args... args)
    {
        std::string text;
        append(text, fmt, args...);
        if (capture) {
            *capture += prefix;
            *capture += text;
        }
        if (echoWarnings) {
            std::fputs(prefix, stderr);
            std::fputs(text.c_str(), stderr);
        }
    }
};

inline ConsoleShim& Console()
{
    static ConsoleShim instance;
    return instance;
}

}  // namespace Base

#endif
