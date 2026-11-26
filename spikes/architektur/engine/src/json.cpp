#include "json.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace hc {

const Json* Json::find(std::string_view key) const {
    if (type_ != Type::Object) return nullptr;
    for (const auto& kv : obj_)
        if (kv.first == key) return &kv.second;
    return nullptr;
}

Json& Json::operator[](const std::string& key) {
    if (type_ == Type::Null) type_ = Type::Object;
    for (auto& kv : obj_)
        if (kv.first == key) return kv.second;
    obj_.emplace_back(key, Json());
    return obj_.back().second;
}

void Json::push(Json v) {
    if (type_ == Type::Null) type_ = Type::Array;
    arr_.push_back(std::move(v));
}

const char* Json::typeName(Type t) {
    switch (t) {
    case Type::Null: return "null";
    case Type::Bool: return "boolean";
    case Type::Number: return "number";
    case Type::String: return "string";
    case Type::Array: return "array";
    case Type::Object: return "object";
    }
    return "?";
}

namespace {

void writeString(std::string& out, const std::string& s) {
    out.push_back('"');
    for (unsigned char c : s) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        default:
            if (c < 0x20) {
                char buf[8];
                std::snprintf(buf, sizeof buf, "\\u%04x", c);
                out += buf;
            } else {
                out.push_back(static_cast<char>(c));  // UTF-8 passes through unchanged
            }
        }
    }
    out.push_back('"');
}

void writeNumber(std::string& out, double d) {
    if (!std::isfinite(d)) { out += "null"; return; }  // JSON has no NaN or infinity
    char buf[32];
    // Integral values up to 2^53 are written without a fraction so ids and counts stay integers.
    if (d == std::floor(d) && std::abs(d) < 9007199254740992.0)
        std::snprintf(buf, sizeof buf, "%lld", static_cast<long long>(d));
    else
        std::snprintf(buf, sizeof buf, "%.17g", d);
    out += buf;
}

class Parser {
public:
    explicit Parser(std::string_view t) : t_(t) {}

    Json parseDocument() {
        skipWs();
        Json v = parseValue(0);
        skipWs();
        if (p_ != t_.size()) fail("unexpected data after the JSON value");
        return v;
    }

private:
    static constexpr int kMaxDepth = 64;
    std::string_view t_;
    size_t p_ = 0;

    [[noreturn]] void fail(const std::string& what) const {
        throw JsonError("JSON parse error at byte " + std::to_string(p_) + ": " + what);
    }
    void skipWs() {
        while (p_ < t_.size() && (t_[p_] == ' ' || t_[p_] == '\t' || t_[p_] == '\n' || t_[p_] == '\r')) ++p_;
    }
    bool consume(std::string_view lit) {
        if (t_.substr(p_, lit.size()) == lit) { p_ += lit.size(); return true; }
        return false;
    }

    Json parseValue(int depth) {
        if (depth > kMaxDepth) fail("nesting deeper than " + std::to_string(kMaxDepth) + " levels");
        if (p_ >= t_.size()) fail("unexpected end of input");
        const char c = t_[p_];
        if (c == '{') return parseObject(depth);
        if (c == '[') return parseArray(depth);
        if (c == '"') return Json(parseString());
        if (c == '-' || (c >= '0' && c <= '9')) return parseNumber();
        if (consume("true")) return Json(true);
        if (consume("false")) return Json(false);
        if (consume("null")) return Json();
        fail(std::string("unexpected character '") + c + "'");
    }

    Json parseObject(int depth) {
        ++p_;  // {
        Json o = Json::object();
        skipWs();
        if (p_ < t_.size() && t_[p_] == '}') { ++p_; return o; }
        for (;;) {
            skipWs();
            if (p_ >= t_.size() || t_[p_] != '"') fail("expected a string key");
            std::string key = parseString();
            skipWs();
            if (p_ >= t_.size() || t_[p_] != ':') fail("expected ':' after key \"" + key + "\"");
            ++p_;
            skipWs();
            if (o.find(key)) fail("duplicate key \"" + key + "\"");
            o[key] = parseValue(depth + 1);
            skipWs();
            if (p_ < t_.size() && t_[p_] == ',') { ++p_; continue; }
            if (p_ < t_.size() && t_[p_] == '}') { ++p_; return o; }
            fail("expected ',' or '}' in object");
        }
    }

    Json parseArray(int depth) {
        ++p_;  // [
        Json a = Json::array();
        skipWs();
        if (p_ < t_.size() && t_[p_] == ']') { ++p_; return a; }
        for (;;) {
            skipWs();
            a.push(parseValue(depth + 1));
            skipWs();
            if (p_ < t_.size() && t_[p_] == ',') { ++p_; continue; }
            if (p_ < t_.size() && t_[p_] == ']') { ++p_; return a; }
            fail("expected ',' or ']' in array");
        }
    }

    unsigned hex4() {
        if (p_ + 4 > t_.size()) fail("truncated \\u escape");
        unsigned v = 0;
        for (int i = 0; i < 4; ++i) {
            const char c = t_[p_++];
            v <<= 4;
            if (c >= '0' && c <= '9') v |= unsigned(c - '0');
            else if (c >= 'a' && c <= 'f') v |= unsigned(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v |= unsigned(c - 'A' + 10);
            else fail("invalid hex digit in \\u escape");
        }
        return v;
    }

    static void appendUtf8(std::string& s, unsigned cp) {
        if (cp < 0x80) s.push_back(char(cp));
        else if (cp < 0x800) { s.push_back(char(0xC0 | (cp >> 6))); s.push_back(char(0x80 | (cp & 0x3F))); }
        else if (cp < 0x10000) {
            s.push_back(char(0xE0 | (cp >> 12)));
            s.push_back(char(0x80 | ((cp >> 6) & 0x3F)));
            s.push_back(char(0x80 | (cp & 0x3F)));
        } else {
            s.push_back(char(0xF0 | (cp >> 18)));
            s.push_back(char(0x80 | ((cp >> 12) & 0x3F)));
            s.push_back(char(0x80 | ((cp >> 6) & 0x3F)));
            s.push_back(char(0x80 | (cp & 0x3F)));
        }
    }

    std::string parseString() {
        ++p_;  // "
        std::string s;
        for (;;) {
            if (p_ >= t_.size()) fail("unterminated string");
            const unsigned char c = static_cast<unsigned char>(t_[p_++]);
            if (c == '"') return s;
            if (c < 0x20) fail("unescaped control character in string");
            if (c != '\\') { s.push_back(char(c)); continue; }
            if (p_ >= t_.size()) fail("unterminated escape");
            const char e = t_[p_++];
            switch (e) {
            case '"': s.push_back('"'); break;
            case '\\': s.push_back('\\'); break;
            case '/': s.push_back('/'); break;
            case 'b': s.push_back('\b'); break;
            case 'f': s.push_back('\f'); break;
            case 'n': s.push_back('\n'); break;
            case 'r': s.push_back('\r'); break;
            case 't': s.push_back('\t'); break;
            case 'u': {
                unsigned cp = hex4();
                if (cp >= 0xD800 && cp <= 0xDBFF) {  // high surrogate: a low one must follow
                    if (!consume("\\u")) fail("high surrogate without low surrogate");
                    const unsigned lo = hex4();
                    if (lo < 0xDC00 || lo > 0xDFFF) fail("invalid low surrogate");
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                    fail("unpaired low surrogate");
                }
                appendUtf8(s, cp);
                break;
            }
            default: fail(std::string("invalid escape '\\") + e + "'");
            }
        }
    }

    Json parseNumber() {
        const size_t start = p_;
        if (t_[p_] == '-') ++p_;
        auto digits = [&] {
            const size_t d0 = p_;
            while (p_ < t_.size() && t_[p_] >= '0' && t_[p_] <= '9') ++p_;
            if (p_ == d0) fail("expected a digit");
        };
        if (p_ < t_.size() && t_[p_] == '0') ++p_; else digits();
        if (p_ < t_.size() && t_[p_] == '.') { ++p_; digits(); }
        if (p_ < t_.size() && (t_[p_] == 'e' || t_[p_] == 'E')) {
            ++p_;
            if (p_ < t_.size() && (t_[p_] == '+' || t_[p_] == '-')) ++p_;
            digits();
        }
        const std::string num(t_.substr(start, p_ - start));
        return Json(std::strtod(num.c_str(), nullptr));
    }
};

} // namespace

void Json::dumpTo(std::string& out) const {
    switch (type_) {
    case Type::Null: out += "null"; break;
    case Type::Bool: out += b_ ? "true" : "false"; break;
    case Type::Number: writeNumber(out, d_); break;
    case Type::String: writeString(out, s_); break;
    case Type::Array:
        out.push_back('[');
        for (size_t i = 0; i < arr_.size(); ++i) {
            if (i) out.push_back(',');
            arr_[i].dumpTo(out);
        }
        out.push_back(']');
        break;
    case Type::Object:
        out.push_back('{');
        for (size_t i = 0; i < obj_.size(); ++i) {
            if (i) out.push_back(',');
            writeString(out, obj_[i].first);
            out.push_back(':');
            obj_[i].second.dumpTo(out);
        }
        out.push_back('}');
        break;
    }
}

std::string Json::dump() const {
    std::string s;
    dumpTo(s);
    return s;
}

Json Json::parse(std::string_view text) { return Parser(text).parseDocument(); }

} // namespace hc
