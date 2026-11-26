// What is still free in a solved sketch, in facts a person can read (the palette's "what is still missing").
//
// planegcs tells which parameters are dependent (can still move) per degree of freedom, but a parameter list is no answer to
// "why is my rectangle not green": eight point coordinates mean "the rectangle can still be moved and has no size". So the
// facts are derived from the motions themselves. At the solved geometry the constraints are linearised (a finite-difference
// Jacobian of every driving constraint, written out in sketch_freedom.cpp for each constraint type), and the null space of the
// Jacobian is the set of first-order motions the sketch still allows - the same freedom planegcs counts as degrees of freedom.
// Per connected shape (elements that share points or constraints) the rigid motions inside that space (move along u, along v,
// turn) are one statement each; what is left is told per element: the length or direction of a line, the radius of a circle,
// a point that moves against the rest.
//
// Sketches with arcs are not analysed (the document has none yet).
#pragma once

#include "sketch/sketch.hpp"

#include <string>
#include <vector>

namespace pc::sketch {

struct FreedomFact {
    // position, rotation, length, direction, radius, point (see the protocol type FreedomFact)
    std::string kind;
    // point, line, circle, rectangle, shape
    std::string shape;
    int moves = 0;  // position only: 2 = anywhere, 1 = along one direction
    std::vector<std::string> elements;
};

struct FreedomReport {
    bool analysed = false;          // false: not supported (arcs) or not computable; the facts are empty then
    int freeMotions = 0;            // dimension of the null space over the whole sketch
    std::vector<FreedomFact> facts;  // in the order of the sketch
};

// `solved` is a solved sketch (its driving constraints hold). Throws nothing: an unsupported or failing analysis is
// reported as analysed = false.
FreedomReport analyseFreedom(const Sketch& solved);

} // namespace pc::sketch
