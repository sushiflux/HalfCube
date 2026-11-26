#include "model/profiles.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <map>
#include <numbers>
#include <set>

namespace pc::model {

namespace {

// Distance below which two curves count as touching (mm). Solved sketches are accurate to about 1e-10 mm.
constexpr double kTouch = 1e-6;

struct P2 {
    double x = 0.0, y = 0.0;
};
P2 operator-(P2 a, P2 b) { return {a.x - b.x, a.y - b.y}; }
double cross(P2 a, P2 b) { return a.x * b.y - a.y * b.x; }
double dot(P2 a, P2 b) { return a.x * b.x + a.y * b.y; }
double len(P2 a) { return std::hypot(a.x, a.y); }

double pointSegment(P2 p, P2 a, P2 b) {
    const P2 d = b - a;
    const double l2 = dot(d, d);
    double t = l2 > 0.0 ? dot(p - a, d) / l2 : 0.0;
    t = std::clamp(t, 0.0, 1.0);
    return len(p - P2{a.x + t * d.x, a.y + t * d.y});
}

double segmentSegment(P2 a, P2 b, P2 c, P2 d) {
    const double d1 = cross(b - a, c - a), d2 = cross(b - a, d - a), d3 = cross(d - c, a - c), d4 = cross(d - c, b - c);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0.0;
    return std::min({pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b)});
}

struct Edge {
    std::string id;
    std::string a, b;  // point groups
    bool alive = true;
};

std::pair<std::string, long long> splitId(const std::string& s) {
    std::size_t i = 0;
    while (i < s.size() && !(s[i] >= '0' && s[i] <= '9')) ++i;
    if (i == s.size() || s.size() - i > 15) return {s, -1};
    for (std::size_t j = i; j < s.size(); ++j)
        if (!(s[j] >= '0' && s[j] <= '9')) return {s, -1};
    return {s.substr(0, i), std::stoll(s.substr(i))};
}

double polygonArea(const std::vector<P2>& pts) {
    double a = 0.0;
    for (std::size_t i = 0; i < pts.size(); ++i) a += cross(pts[i], pts[(i + 1) % pts.size()]);
    return a / 2.0;
}

bool insidePolygon(P2 p, const std::vector<P2>& poly) {
    bool in = false;
    for (std::size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
        const P2 a = poly[i], b = poly[j];
        if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) in = !in;
    }
    return in;
}

// A traced loop with its geometry for the containment tests.
struct Traced {
    Loop loop;
    std::vector<P2> polygon;  // corner positions (line loops)
    bool circle = false;
    P2 center;
    double radius = 0.0;
    int component = -1;
    double signedArea = 0.0;
};

void rotateToSmallest(Loop& l) {
    if (l.curves.size() < 2) return;
    const auto first = std::min_element(l.curves.begin(), l.curves.end(), [](const LoopCurve& a, const LoopCurve& b) { return naturalLess(a.id, b.id); });
    std::rotate(l.curves.begin(), first, l.curves.end());
}

std::string sortedIds(const Loop& l) {
    std::vector<std::string> ids;
    for (const auto& c : l.curves) ids.push_back(c.id);
    std::sort(ids.begin(), ids.end(), naturalLess);
    std::string s;
    for (const auto& id : ids) s += (s.empty() ? "" : ",") + id;
    return s;
}

} // namespace

bool naturalLess(const std::string& a, const std::string& b) {
    const auto [pa, na] = splitId(a);
    const auto [pb, nb] = splitId(b);
    if (na >= 0 && nb >= 0) {
        if (pa != pb) return pa < pb;
        if (na != nb) return na < nb;
    }
    return a < b;
}

std::vector<std::string> RegionInfo::outerIds() const {
    std::vector<std::string> r;
    for (const auto& c : outer.curves) r.push_back(c.id);
    return r;
}

std::vector<std::vector<std::string>> RegionInfo::holeIds() const {
    std::vector<std::vector<std::string>> r;
    for (const auto& h : holes) {
        auto& ids = r.emplace_back();
        for (const auto& c : h.curves) ids.push_back(c.id);
    }
    return r;
}

std::size_t RegionInfo::curveCount() const {
    std::size_t n = outer.curves.size();
    for (const auto& h : holes) n += h.curves.size();
    return n;
}

std::map<std::string, std::string> pointGroups(const sketch::Sketch& s) {
    std::map<std::string, std::size_t> index;
    for (std::size_t i = 0; i < s.points.size(); ++i) index[s.points[i].id] = i;
    std::vector<std::size_t> parent(s.points.size());
    for (std::size_t i = 0; i < parent.size(); ++i) parent[i] = i;
    const std::function<std::size_t(std::size_t)> find = [&](std::size_t i) { return parent[i] == i ? i : parent[i] = find(parent[i]); };
    for (const auto& c : s.constraints) {
        if (c.type != sketch::ConstraintType::Coincident || !c.driving || c.refs.size() != 2) continue;
        const auto a = index.find(c.refs[0]), b = index.find(c.refs[1]);
        if (a == index.end() || b == index.end()) continue;
        const std::size_t ra = find(a->second), rb = find(b->second);
        // The earlier point in list order names the group.
        if (ra != rb) parent[std::max(ra, rb)] = std::min(ra, rb);
    }
    std::map<std::string, std::string> groups;
    for (std::size_t i = 0; i < s.points.size(); ++i) groups[s.points[i].id] = s.points[find(i)].id;
    return groups;
}

ProfileResult findRegions(const sketch::Sketch& s) {
    ProfileResult result;
    const auto groups = pointGroups(s);
    std::map<std::string, P2> pos;
    for (const auto& p : s.points) pos[p.id] = {p.x, p.y};
    const auto at = [&](const std::string& group) { return pos.at(group); };

    std::vector<Edge> edges;
    for (const auto& l : s.lines) {
        if (l.construction) continue;
        const std::string a = groups.at(l.p1), b = groups.at(l.p2);
        if (a == b || len(at(a) - at(b)) <= kTouch) continue;  // a line that collapsed to a point bounds nothing
        edges.push_back({l.id, a, b, true});
    }
    std::vector<const sketch::Circle*> circles;
    for (const auto& c : s.circles)
        if (!c.construction) circles.push_back(&c);

    // ---- crossing and touching curves
    std::set<std::string> bad;
    const auto cross2 = [&](const std::string& x, const std::string& y) {
        bad.insert(x);
        bad.insert(y);
        result.crossings.emplace_back(x, y);
    };
    for (std::size_t i = 0; i < edges.size(); ++i) {
        for (std::size_t j = i + 1; j < edges.size(); ++j) {
            const Edge &e = edges[i], &f = edges[j];
            const int shared = (e.a == f.a || e.a == f.b) + (e.b == f.a || e.b == f.b);
            const P2 a = at(e.a), b = at(e.b), c = at(f.a), d = at(f.b);
            if (shared == 2) {
                cross2(e.id, f.id);  // two lines over the same two points
            } else if (shared == 1) {
                // Sharing an end point, they can only overlap: the other end of one lies on the other.
                const P2 other1 = (e.a == f.a || e.a == f.b) ? b : a;
                const P2 other2 = (f.a == e.a || f.a == e.b) ? d : c;
                if (pointSegment(other1, c, d) <= kTouch || pointSegment(other2, a, b) <= kTouch) cross2(e.id, f.id);
            } else if (segmentSegment(a, b, c, d) <= kTouch) {
                cross2(e.id, f.id);
            }
        }
        for (const auto* c : circles) {
            const P2 m = at(groups.at(c->center));
            const P2 a = at(edges[i].a), b = at(edges[i].b);
            const double near = pointSegment(m, a, b), far = std::max(len(a - m), len(b - m));
            if (near <= c->radius + kTouch && far >= c->radius - kTouch) cross2(edges[i].id, c->id);
        }
    }
    for (std::size_t i = 0; i < circles.size(); ++i)
        for (std::size_t j = i + 1; j < circles.size(); ++j) {
            const double d = len(at(groups.at(circles[i]->center)) - at(groups.at(circles[j]->center)));
            const double r1 = circles[i]->radius, r2 = circles[j]->radius;
            if (d <= r1 + r2 + kTouch && d >= std::abs(r1 - r2) - kTouch) cross2(circles[i]->id, circles[j]->id);
        }
    for (auto& e : edges)
        if (bad.count(e.id)) e.alive = false;
    result.intersecting.assign(bad.begin(), bad.end());
    std::sort(result.intersecting.begin(), result.intersecting.end(), naturalLess);

    // ---- drop loose ends and bridges until nothing changes
    for (bool changed = true; changed;) {
        changed = false;
        for (bool stripped = true; stripped;) {
            stripped = false;
            std::map<std::string, int> degree;
            for (const auto& e : edges)
                if (e.alive) {
                    ++degree[e.a];
                    ++degree[e.b];
                }
            for (auto& e : edges)
                if (e.alive && (degree[e.a] < 2 || degree[e.b] < 2)) {
                    e.alive = false;
                    stripped = changed = true;
                }
        }
        // Bridges (Tarjan): an edge whose removal disconnects its ends bounds no area on either side.
        std::map<std::string, std::vector<std::size_t>> adj;
        for (std::size_t i = 0; i < edges.size(); ++i)
            if (edges[i].alive) {
                adj[edges[i].a].push_back(i);
                adj[edges[i].b].push_back(i);
            }
        std::map<std::string, int> order, low;
        int counter = 0;
        std::vector<std::size_t> bridges;
        const std::function<void(const std::string&, std::size_t)> dfs = [&](const std::string& v, std::size_t viaEdge) {
            order[v] = low[v] = ++counter;
            for (std::size_t ei : adj[v]) {
                if (ei == viaEdge) continue;
                const std::string& w = edges[ei].a == v ? edges[ei].b : edges[ei].a;
                if (!order.count(w)) {
                    dfs(w, ei);
                    low[v] = std::min(low[v], low[w]);
                    if (low[w] > order[v]) bridges.push_back(ei);
                } else {
                    low[v] = std::min(low[v], order[w]);
                }
            }
        };
        for (const auto& [v, list] : adj)
            if (!order.count(v)) dfs(v, static_cast<std::size_t>(-1));
        for (std::size_t ei : bridges) {
            edges[ei].alive = false;
            changed = true;
        }
    }

    // ---- components (union of points over the remaining edges)
    std::map<std::string, std::string> comp;
    const std::function<std::string(const std::string&)> root = [&](const std::string& g) {
        auto it = comp.find(g);
        if (it == comp.end() || it->second == g) return g;
        return it->second = root(it->second);
    };
    for (const auto& e : edges)
        if (e.alive) {
            comp.try_emplace(e.a, e.a);
            comp.try_emplace(e.b, e.b);
            const std::string ra = root(e.a), rb = root(e.b);
            if (ra != rb) comp[ra] = rb;
        }
    std::map<std::string, int> componentIndex;
    for (const auto& [g, unused] : comp) {
        (void)unused;
        componentIndex.try_emplace(root(g), static_cast<int>(componentIndex.size()));
    }

    // ---- faces over half-edges; half-edge 2i runs a -> b, 2i + 1 runs b -> a
    std::map<std::string, std::vector<std::size_t>> out;
    const auto fromOf = [&](std::size_t h) -> const std::string& { return h % 2 == 0 ? edges[h / 2].a : edges[h / 2].b; };
    const auto toOf = [&](std::size_t h) -> const std::string& { return h % 2 == 0 ? edges[h / 2].b : edges[h / 2].a; };
    for (std::size_t i = 0; i < edges.size(); ++i)
        if (edges[i].alive) {
            out[edges[i].a].push_back(2 * i);
            out[edges[i].b].push_back(2 * i + 1);
        }
    for (auto& [v, list] : out) {
        const P2 o = at(v);
        std::sort(list.begin(), list.end(), [&](std::size_t x, std::size_t y) {
            const P2 dx = at(toOf(x)) - o, dy = at(toOf(y)) - o;
            const double ax = std::atan2(dx.y, dx.x), ay = std::atan2(dy.y, dy.x);
            return ax != ay ? ax < ay : x < y;
        });
    }
    std::vector<Traced> bounded;
    std::map<int, Traced> boundary;  // per component: its outer boundary (negative face), as a hole loop
    std::set<std::size_t> used;
    for (std::size_t i = 0; i < edges.size(); ++i) {
        if (!edges[i].alive) continue;
        for (std::size_t start : {2 * i, 2 * i + 1}) {
            if (used.count(start)) continue;
            Traced t;
            std::size_t h = start;
            do {
                used.insert(h);
                t.loop.curves.push_back({edges[h / 2].id, false, fromOf(h), toOf(h)});
                t.polygon.push_back(at(fromOf(h)));
                const auto& list = out.at(toOf(h));
                const std::size_t twin = h ^ 1u;
                const std::size_t k = static_cast<std::size_t>(std::find(list.begin(), list.end(), twin) - list.begin());
                h = list[(k + list.size() - 1) % list.size()];
            } while (h != start && t.loop.curves.size() <= 2 * edges.size());
            t.signedArea = polygonArea(t.polygon);
            t.loop.area = std::abs(t.signedArea);
            t.component = componentIndex.at(root(edges[i].a));
            if (t.loop.area <= kTouch * kTouch) continue;
            if (t.signedArea > 0) bounded.push_back(std::move(t));
            else if (!boundary.count(t.component) || t.loop.area > boundary.at(t.component).loop.area) boundary[t.component] = std::move(t);
        }
    }
    int nextComponent = static_cast<int>(componentIndex.size());
    for (const auto* c : circles) {
        if (bad.count(c->id)) continue;
        Traced t;
        t.circle = true;
        t.center = at(groups.at(c->center));
        t.radius = c->radius;
        t.loop.curves.push_back({c->id, true, {}, {}});
        t.loop.area = std::numbers::pi * c->radius * c->radius;
        t.component = nextComponent++;
        boundary[t.component] = t;
        bounded.push_back(std::move(t));
    }

    // ---- nesting: every component goes into the smallest loop of another component around it
    const auto contains = [](const Traced& loop, P2 p) {
        return loop.circle ? len(p - loop.center) < loop.radius : insidePolygon(p, loop.polygon);
    };
    std::vector<std::vector<int>> holesOf(bounded.size());
    for (const auto& [component, outline] : boundary) {
        const P2 probe = outline.circle ? P2{outline.center.x + outline.radius, outline.center.y} : outline.polygon.front();
        int best = -1;
        for (std::size_t i = 0; i < bounded.size(); ++i) {
            if (bounded[i].component == component || !contains(bounded[i], probe)) continue;
            if (best < 0 || bounded[i].loop.area < bounded[static_cast<std::size_t>(best)].loop.area) best = static_cast<int>(i);
        }
        if (best >= 0) holesOf[static_cast<std::size_t>(best)].push_back(component);
    }

    for (std::size_t i = 0; i < bounded.size(); ++i) {
        RegionInfo r;
        r.outer = bounded[i].loop;
        rotateToSmallest(r.outer);
        r.area = r.outer.area;
        std::vector<std::string> holeKeys;
        for (int component : holesOf[i]) {
            Loop hole = boundary.at(component).loop;  // already clockwise for line loops; circles are walked reversed
            rotateToSmallest(hole);
            r.area -= hole.area;
            r.holes.push_back(std::move(hole));
        }
        std::sort(r.holes.begin(), r.holes.end(), [](const Loop& a, const Loop& b) { return sortedIds(a) < sortedIds(b); });
        r.key = sortedIds(r.outer);
        for (const auto& h : r.holes) r.key += "|" + sortedIds(h);
        result.regions.push_back(std::move(r));
    }
    std::sort(result.regions.begin(), result.regions.end(), [](const RegionInfo& a, const RegionInfo& b) { return a.key < b.key; });
    return result;
}

} // namespace pc::model
