// Small JSON value with parser and writer, enough for the engine's message headers and recipes.
// Object members keep their insertion order so that written messages are stable and diffable.
#pragma once

#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace pc {

class JsonError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

class Json {
public:
    enum class Type { Null, Bool, Number, String, Array, Object };

    Json() = default;
    Json(std::nullptr_t) {}
    Json(bool b) : type_(Type::Bool), b_(b) {}
    Json(int v) : type_(Type::Number), d_(v) {}
    Json(unsigned v) : type_(Type::Number), d_(v) {}
    Json(long v) : type_(Type::Number), d_(static_cast<double>(v)) {}
    Json(unsigned long v) : type_(Type::Number), d_(static_cast<double>(v)) {}
    Json(long long v) : type_(Type::Number), d_(static_cast<double>(v)) {}
    Json(unsigned long long v) : type_(Type::Number), d_(static_cast<double>(v)) {}
    Json(double v) : type_(Type::Number), d_(v) {}
    Json(const char* s) : type_(Type::String), s_(s) {}
    Json(std::string s) : type_(Type::String), s_(std::move(s)) {}
    Json(std::string_view s) : type_(Type::String), s_(s) {}

    static Json object() { Json j; j.type_ = Type::Object; return j; }
    static Json array() { Json j; j.type_ = Type::Array; return j; }

    Type type() const { return type_; }
    bool isNull() const { return type_ == Type::Null; }
    bool isBool() const { return type_ == Type::Bool; }
    bool isNumber() const { return type_ == Type::Number; }
    bool isString() const { return type_ == Type::String; }
    bool isArray() const { return type_ == Type::Array; }
    bool isObject() const { return type_ == Type::Object; }

    bool boolean() const { return b_; }
    double number() const { return d_; }
    const std::string& str() const { return s_; }
    const std::vector<Json>& items() const { return arr_; }
    const std::vector<std::pair<std::string, Json>>& members() const { return obj_; }
    size_t size() const { return type_ == Type::Array ? arr_.size() : obj_.size(); }

    // Object lookup; nullptr when this is not an object or the key is missing.
    const Json* find(std::string_view key) const;

    // Object access that inserts the key (in insertion order) when missing; turns null into an object.
    Json& operator[](const std::string& key);
    // Array append; turns null into an array.
    void push(Json v);

    std::string dump() const;
    void dumpTo(std::string& out) const;

    // Parses one JSON text. Throws JsonError("... at byte N") on malformed input.
    static Json parse(std::string_view text);

    // Name of a type for error messages ("number", "string", ...).
    static const char* typeName(Type t);

private:
    Type type_ = Type::Null;
    bool b_ = false;
    double d_ = 0;
    std::string s_;
    std::vector<Json> arr_;
    std::vector<std::pair<std::string, Json>> obj_;
};

} // namespace pc
