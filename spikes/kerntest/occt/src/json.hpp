// Minimal JSON value with ordered object keys, enough for writing test results.
#pragma once

#include <cmath>
#include <cstdio>
#include <initializer_list>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace kt {

class Json {
public:
    enum class Type { Null, Bool, Number, Integer, String, Array, Object };

    Json() = default;
    Json(std::nullptr_t) {}
    Json(bool b) : type_(Type::Bool), b_(b) {}
    Json(int i) : type_(Type::Integer), i_(i) {}
    Json(long long i) : type_(Type::Integer), i_(i) {}
    Json(size_t i) : type_(Type::Integer), i_(static_cast<long long>(i)) {}
    Json(double d) : type_(Type::Number), d_(d) {}
    Json(const char* s) : type_(Type::String), s_(s) {}
    Json(std::string s) : type_(Type::String), s_(std::move(s)) {}

    static Json object() { Json j; j.type_ = Type::Object; return j; }
    static Json array() { Json j; j.type_ = Type::Array; return j; }

    // Object access: inserts the key in insertion order when missing.
    Json& operator[](const std::string& key) {
        if (type_ == Type::Null) type_ = Type::Object;
        for (auto& kv : obj_) if (kv.first == key) return kv.second;
        obj_.emplace_back(key, Json());
        return obj_.back().second;
    }
    void push(Json v) {
        if (type_ == Type::Null) type_ = Type::Array;
        arr_.push_back(std::move(v));
    }
    bool empty() const { return obj_.empty() && arr_.empty(); }
    Type type() const { return type_; }

    // Measured numbers are written with four significant digits (measurement rule in PARTS.md).
    std::string dump(int indent = 0) const {
        std::string out;
        write(out, indent, 0);
        return out;
    }

private:
    static void escape(std::string& out, const std::string& s) {
        out += '"';
        for (unsigned char c : s) {
            switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) { char buf[8]; std::snprintf(buf, sizeof buf, "\\u%04x", c); out += buf; }
                else out += static_cast<char>(c);
            }
        }
        out += '"';
    }
    void write(std::string& out, int indent, int level) const {
        const std::string pad(indent * (level + 1), ' ');
        const std::string padEnd(indent * level, ' ');
        const char* nl = indent ? "\n" : "";
        switch (type_) {
        case Type::Null: out += "null"; break;
        case Type::Bool: out += b_ ? "true" : "false"; break;
        case Type::Integer: out += std::to_string(i_); break;
        case Type::Number: {
            if (!std::isfinite(d_)) { out += "null"; break; }
            char buf[32];
            std::snprintf(buf, sizeof buf, "%.4g", d_);
            out += buf;
            break;
        }
        case Type::String: escape(out, s_); break;
        case Type::Array:
            if (arr_.empty()) { out += "[]"; break; }
            out += "["; out += nl;
            for (size_t i = 0; i < arr_.size(); ++i) {
                out += pad; arr_[i].write(out, indent, level + 1);
                if (i + 1 < arr_.size()) out += ",";
                out += nl;
            }
            out += padEnd; out += "]";
            break;
        case Type::Object:
            if (obj_.empty()) { out += "{}"; break; }
            out += "{"; out += nl;
            for (size_t i = 0; i < obj_.size(); ++i) {
                out += pad; escape(out, obj_[i].first); out += indent ? ": " : ":";
                obj_[i].second.write(out, indent, level + 1);
                if (i + 1 < obj_.size()) out += ",";
                out += nl;
            }
            out += padEnd; out += "}";
            break;
        }
    }

    Type type_ = Type::Null;
    bool b_ = false;
    long long i_ = 0;
    double d_ = 0;
    std::string s_;
    std::vector<Json> arr_;
    std::vector<std::pair<std::string, Json>> obj_;
};

} // namespace kt
