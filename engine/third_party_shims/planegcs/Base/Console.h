// Stand-in for FreeCAD's Base/Console.h. planegcs includes it in GCS.cpp only to log text through
// Base::Console().log(...) and Base::Console().warning(...) with printf-style arguments; FreeCAD's real console is a
// singleton of its application framework. Log text is dropped; warnings and errors go to stderr with the prefix
// "planegcs: " (the engine's diagnostic stream; never the protocol stream).
#ifndef HALFCUBE_PLANEGCS_SHIM_BASE_CONSOLE_H
#define HALFCUBE_PLANEGCS_SHIM_BASE_CONSOLE_H

#include <cstdio>
#include <string>
#include <vector>

namespace Base
{

class ConsoleShim
{
public:
    template<typename... Args>
    void log(const char*, Args...)
    {}

    template<typename... Args>
    void message(const char*, Args...)
    {}

    template<typename... Args>
    void warning(const char* fmt, Args... args)
    {
        emit("planegcs: warning: ", fmt, args...);
    }

    template<typename... Args>
    void error(const char* fmt, Args... args)
    {
        emit("planegcs: error: ", fmt, args...);
    }

private:
    template<typename... Args>
    static void emit(const char* prefix, const char* fmt, Args... args)
    {
        std::string text;
        if constexpr (sizeof...(Args) == 0) {
            text = fmt;
        }
        else {
            const int n = std::snprintf(nullptr, 0, fmt, args...);
            if (n <= 0) {
                return;
            }
            std::vector<char> buf(static_cast<size_t>(n) + 1);
            std::snprintf(buf.data(), buf.size(), fmt, args...);
            text.assign(buf.data(), static_cast<size_t>(n));
        }
        std::fputs(prefix, stderr);
        std::fputs(text.c_str(), stderr);
        if (text.empty() || text.back() != '\n') {
            std::fputc('\n', stderr);
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
