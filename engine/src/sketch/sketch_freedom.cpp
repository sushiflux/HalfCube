#include "sketch/sketch_freedom.hpp"

#include "sketch/sketch_check.hpp"
#include "sketch/sketch_solver.hpp"

#include <Eigen/Core>
#include <Eigen/SVD>

#include <algorithm>
#include <cmath>
#include <map>
#include <numbers>
#include <set>
#include <unordered_map>

namespace hc::sketch {

namespace {

using Vec = Eigen::Vector2d;
using Mat = Eigen::MatrixXd;
using Row = Eigen::RowVectorXd;

// Larger shapes than this (parameters in one connected shape) are not analysed: the SVD would cost more than a drag step.
constexpr int kMaxParameters = 360;
// Singular values and projections below this count as zero. The Jacobian comes from central differences with a step of
// 1e-6 mm, whose error is far below it.
constexpr double kZero = 1e-7;
// A motion of an element smaller than this (per unit of motion of the shape's null space) is no freedom.
constexpr double kFree = 1e-6;
constexpr double kStep = 1e-6;

double cross2(const Vec& a, const Vec& b) { return a.x() * b.y() - a.y() * b.x(); }

double wrapAngle(double a) {
    while (a > std::numbers::pi) a -= 2.0 * std::numbers::pi;
    while (a <= -std::numbers::pi) a += 2.0 * std::numbers::pi;
    return a;
}

// A mutable copy of the solved sketch with lookups by id; the parameters are perturbed through the stored pointers.
struct Geo {
    Sketch s;
    std::unordered_map<std::string, Point*> points;
    std::unordered_map<std::string, const Line*> lines;
    std::unordered_map<std::string, Circle*> circles;

    explicit Geo(const Sketch& in) : s(in) {
        for (Point& p : s.points) points[p.id] = &p;
        for (const Line& l : s.lines) lines[l.id] = &l;
        for (Circle& c : s.circles) circles[c.id] = &c;
    }
    Geo(const Geo&) = delete;
    Geo& operator=(const Geo&) = delete;

    Vec pt(const std::string& id) const {
        if (id == kOrigin) return {0.0, 0.0};
        const auto it = points.find(id);
        if (it == points.end()) throw SketchError("freedom: no point " + id);
        return {it->second->x, it->second->y};
    }
    struct Seg {
        Vec a, b;
    };
    Seg ln(const std::string& id) const {
        if (id == kAxisU) return {{0.0, 0.0}, {1.0, 0.0}};
        if (id == kAxisV) return {{0.0, 0.0}, {0.0, 1.0}};
        const auto it = lines.find(id);
        if (it == lines.end()) throw SketchError("freedom: no line " + id);
        return {pt(it->second->p1), pt(it->second->p2)};
    }
    struct Rnd {
        Vec c;
        double r;
    };
    Rnd rd(const std::string& id) const {
        const auto it = circles.find(id);
        if (it == circles.end()) throw SketchError("freedom: no circle " + id);
        return {pt(it->second->center), it->second->radius};
    }
};

double lengthOf(const Vec& v) { return v.norm(); }

// The signed residuals of one driving constraint at the geometry g (anchor: the solved geometry, where a fixing holds).
// Zero where the constraint holds; what matters is how they change when the parameters move.
void residualsOf(const Geo& g, const Geo& anchor, const Constraint& c, std::vector<double>& out) {
    const auto ref = [&](std::size_t i) -> const std::string& {
        if (c.refs.size() <= i) throw SketchError("freedom: too few references");
        return c.refs[i];
    };
    const auto unitDot = [](const Vec& u, const Vec& v) { return u.dot(v) / (u.norm() * v.norm()); };
    switch (c.type) {
    case ConstraintType::Coincident: {
        const Vec d = g.pt(ref(0)) - g.pt(ref(1));
        out.push_back(d.x());
        out.push_back(d.y());
        return;
    }
    case ConstraintType::Horizontal: {
        const auto l = g.ln(ref(0));
        out.push_back(l.b.y() - l.a.y());
        return;
    }
    case ConstraintType::Vertical: {
        const auto l = g.ln(ref(0));
        out.push_back(l.b.x() - l.a.x());
        return;
    }
    case ConstraintType::Parallel: {
        const auto a = g.ln(ref(0)), b = g.ln(ref(1));
        const Vec u = a.b - a.a, v = b.b - b.a;
        out.push_back(cross2(u, v) / (u.norm() * v.norm()));
        return;
    }
    case ConstraintType::Perpendicular: {
        const auto a = g.ln(ref(0)), b = g.ln(ref(1));
        out.push_back(unitDot(a.b - a.a, b.b - b.a));
        return;
    }
    case ConstraintType::Tangent: {
        const auto l = g.ln(ref(0));
        const auto r = g.rd(ref(1));
        const Vec d = l.b - l.a;
        out.push_back(std::abs(cross2(d, r.c - l.a)) / d.norm() - r.r);
        return;
    }
    case ConstraintType::PointOnLine: {
        const auto l = g.ln(ref(1));
        const Vec d = l.b - l.a;
        out.push_back(cross2(d, g.pt(ref(0)) - l.a) / d.norm());
        return;
    }
    case ConstraintType::PointOnCircle: {
        const auto r = g.rd(ref(1));
        out.push_back((g.pt(ref(0)) - r.c).norm() - r.r);
        return;
    }
    case ConstraintType::EqualLength: {
        const auto a = g.ln(ref(0)), b = g.ln(ref(1));
        out.push_back(lengthOf(a.b - a.a) - lengthOf(b.b - b.a));
        return;
    }
    case ConstraintType::EqualRadius: out.push_back(g.rd(ref(0)).r - g.rd(ref(1)).r); return;
    case ConstraintType::Fix: {
        const std::string& id = ref(0);
        if (g.points.count(id)) {
            const Vec d = g.pt(id) - anchor.pt(id);
            out.push_back(d.x());
            out.push_back(d.y());
        } else if (g.lines.count(id)) {
            const auto now = g.ln(id), was = anchor.ln(id);
            const Vec da = now.a - was.a, db = now.b - was.b;
            for (const Vec* d : {&da, &db}) {
                out.push_back(d->x());
                out.push_back(d->y());
            }
        } else {
            const auto now = g.rd(id), was = anchor.rd(id);
            out.push_back((now.c - was.c).x());
            out.push_back((now.c - was.c).y());
            out.push_back(now.r - was.r);
        }
        return;
    }
    case ConstraintType::LineAngle:
    case ConstraintType::LineLineAngle: out.push_back(wrapAngle(measure(g.s, c) - c.value)); return;
    case ConstraintType::Distance:
    case ConstraintType::DistanceX:
    case ConstraintType::DistanceY:
    case ConstraintType::Radius:
    case ConstraintType::Diameter:
    case ConstraintType::DistancePointLine:
    case ConstraintType::DistanceLineLine:
    case ConstraintType::DistancePointCircle:
    case ConstraintType::DistanceCircleLine:
    case ConstraintType::DistanceCircleCircle: out.push_back(measure(g.s, c) - c.value); return;
    }
    throw SketchError("freedom: unknown constraint type");
}

// Union-find over element ids.
struct Groups {
    std::map<std::string, std::string> parent;
    const std::string& find(const std::string& id) {
        auto it = parent.find(id);
        if (it == parent.end()) it = parent.emplace(id, id).first;
        if (it->second == id) return it->first;
        const std::string root = find(it->second);
        parent[id] = root;
        return parent[id];
    }
    void join(const std::string& a, const std::string& b) {
        const std::string ra = find(a), rb = find(b);
        if (ra != rb) parent[ra] = rb;
    }
};

struct Param {
    double* value;
    std::string element;  // point id or circle id
    char axis;            // 'x', 'y', 'r'
};

int rankOf(const Mat& m) {
    if (m.cols() == 0 || m.rows() == 0) return 0;
    Eigen::JacobiSVD<Mat> svd(m);
    const auto& sv = svd.singularValues();
    const double top = sv.size() > 0 ? sv(0) : 0.0;
    int rank = 0;
    for (int i = 0; i < sv.size(); ++i)
        if (sv(i) > kZero * std::max(1.0, top)) ++rank;
    return rank;
}

// Orthonormal basis of the column space (columns of U above the threshold).
Mat columnBasis(const Mat& m) {
    if (m.cols() == 0 || m.rows() == 0) return Mat(m.rows(), 0);
    Eigen::JacobiSVD<Mat> svd(m, Eigen::ComputeThinU);
    const auto& sv = svd.singularValues();
    const double top = sv.size() > 0 ? sv(0) : 0.0;
    int rank = 0;
    for (int i = 0; i < sv.size(); ++i)
        if (sv(i) > kZero * std::max(1.0, top)) ++rank;
    return svd.matrixU().leftCols(rank);
}

// Orthonormal basis of the null space of m (n columns).
Mat nullBasis(const Mat& m, int n) {
    if (m.rows() == 0) return Mat::Identity(n, n);
    Eigen::JacobiSVD<Mat> svd(m, Eigen::ComputeFullV);
    const auto& sv = svd.singularValues();
    const double top = sv.size() > 0 ? sv(0) : 0.0;
    int rank = 0;
    for (int i = 0; i < sv.size(); ++i)
        if (sv(i) > kZero * std::max(1.0, top)) ++rank;
    return svd.matrixV().rightCols(n - rank);
}

// Rows that point the same way (up to sign) belong together.
bool parallelRows(const Row& a, const Row& b) {
    const double na = a.norm(), nb = b.norm();
    return na > 0.0 && nb > 0.0 && std::abs(a.dot(b)) / (na * nb) > 1.0 - 1e-9;
}

struct Component {
    std::vector<std::string> points, lines, circles;  // sketch order
    std::vector<std::size_t> constraints;
};

std::string classify(const Geo& g, const Component& c) {
    if (c.lines.empty() && c.circles.empty() && c.points.size() == 1) return "point";
    if (c.lines.size() == 1 && c.circles.empty()) return "line";
    if (c.lines.empty() && c.circles.size() == 1) return "circle";
    if (c.lines.size() == 4 && c.circles.empty() && c.points.size() == 4) {
        // A closed loop of four lines whose neighbours are square.
        std::map<std::string, std::vector<std::string>> at;  // point -> lines
        for (const std::string& id : c.lines) {
            const Line* l = g.lines.at(id);
            at[l->p1].push_back(id);
            at[l->p2].push_back(id);
        }
        for (const auto& [p, ids] : at) {
            if (ids.size() != 2) return "shape";
            const auto a = g.ln(ids[0]), b = g.ln(ids[1]);
            const Vec u = a.b - a.a, v = b.b - b.a;
            if (u.norm() == 0.0 || v.norm() == 0.0 || std::abs(u.dot(v)) / (u.norm() * v.norm()) > 1e-6) return "shape";
        }
        return "rectangle";
    }
    return "shape";
}

} // namespace

FreedomReport analyseFreedom(const Sketch& solved) {
    FreedomReport report;
    if (!solved.arcs.empty()) return report;
    try {
        const Geo anchor(solved);
        Geo g(solved);

        // Connected shapes: elements joined by lines, circles and by what a constraint refers to together.
        Groups groups;
        for (const Point& p : solved.points) groups.find(p.id);
        for (const Line& l : solved.lines) {
            groups.join(l.id, l.p1);
            groups.join(l.id, l.p2);
        }
        for (const Circle& c : solved.circles) groups.join(c.id, c.center);
        for (std::size_t i = 0; i < solved.constraints.size(); ++i) {
            const Constraint& c = solved.constraints[i];
            if (!c.driving) continue;
            const std::string* first = nullptr;
            for (const std::string& r : c.refs) {
                if (isReserved(r)) continue;
                if (!first) first = &r;
                else groups.join(*first, r);
            }
        }
        std::vector<std::string> order;  // roots in order of first appearance
        std::map<std::string, Component> comps;
        const auto component = [&](const std::string& id) -> Component& {
            const std::string root = groups.find(id);
            if (!comps.count(root)) order.push_back(root);
            return comps[root];
        };
        for (const Point& p : solved.points) component(p.id).points.push_back(p.id);
        for (const Line& l : solved.lines) component(l.id).lines.push_back(l.id);
        for (const Circle& c : solved.circles) component(c.id).circles.push_back(c.id);
        for (std::size_t i = 0; i < solved.constraints.size(); ++i) {
            const Constraint& c = solved.constraints[i];
            if (!c.driving) continue;
            for (const std::string& r : c.refs)
                if (!isReserved(r)) {
                    component(r).constraints.push_back(i);
                    break;
                }
        }

        report.analysed = true;
        for (const std::string& root : order) {
            const Component& comp = comps.at(root);
            // The parameters: both coordinates of every point that can move, the radius of every circle.
            std::vector<Param> params;
            std::map<std::string, int> xIndex, yIndex, rIndex;
            for (const std::string& id : comp.points) {
                Point* p = g.points.at(id);
                if (p->fixed) continue;
                xIndex[id] = static_cast<int>(params.size());
                params.push_back({&p->x, id, 'x'});
                yIndex[id] = static_cast<int>(params.size());
                params.push_back({&p->y, id, 'y'});
            }
            for (const std::string& id : comp.circles) {
                rIndex[id] = static_cast<int>(params.size());
                params.push_back({&g.circles.at(id)->radius, id, 'r'});
            }
            const int n = static_cast<int>(params.size());
            if (n == 0) continue;
            if (n > kMaxParameters) {
                report.analysed = false;
                report.facts.clear();
                return report;
            }

            // Jacobian of the constraints of this shape by central differences.
            const auto evaluate = [&]() {
                std::vector<double> out;
                for (std::size_t i : comp.constraints) residualsOf(g, anchor, solved.constraints[i], out);
                return out;
            };
            const std::size_t rows = evaluate().size();
            Mat jac(static_cast<Eigen::Index>(rows), n);
            for (int j = 0; j < n; ++j) {
                double& v = *params[static_cast<std::size_t>(j)].value;
                const double v0 = v;
                v = v0 + kStep;
                const std::vector<double> plus = evaluate();
                v = v0 - kStep;
                const std::vector<double> minus = evaluate();
                v = v0;
                for (std::size_t r = 0; r < rows; ++r) jac(static_cast<Eigen::Index>(r), j) = (plus[r] - minus[r]) / (2.0 * kStep);
            }
            const Mat free = nullBasis(rows == 0 ? Mat(0, n) : jac, n);
            const int k = static_cast<int>(free.cols());
            report.freeMotions += k;
            if (k == 0) continue;

            // Rigid motions of the whole shape: along u, along v, a turn about the centre of its points.
            Mat rigid = Mat::Zero(n, 3);
            double cx = 0.0, cy = 0.0;
            int movable = 0;
            for (const std::string& id : comp.points)
                if (xIndex.count(id)) {
                    cx += *params[static_cast<std::size_t>(xIndex[id])].value;
                    cy += *params[static_cast<std::size_t>(yIndex[id])].value;
                    ++movable;
                }
            if (movable > 0) {
                cx /= movable;
                cy /= movable;
            }
            for (const std::string& id : comp.points)
                if (xIndex.count(id)) {
                    const int ix = xIndex[id], iy = yIndex[id];
                    rigid(ix, 0) = 1.0;
                    rigid(iy, 1) = 1.0;
                    rigid(ix, 2) = -(*params[static_cast<std::size_t>(iy)].value - cy);
                    rigid(iy, 2) = *params[static_cast<std::size_t>(ix)].value - cx;
                }
            Mat withTurn = rigid;
            const Mat translations = rigid.leftCols(2);
            const bool canTurn = rigid.col(2).norm() > 1e-12;
            if (!canTurn) withTurn = translations;
            const auto joined = [&](const Mat& extra) {
                Mat m(n, k + extra.cols());
                m << free, extra;
                return m;
            };
            const int rankT = rankOf(translations);
            const int moves = k + rankT - rankOf(joined(translations));
            const int rankRigid = rankOf(withTurn);
            const int rigidInside = k + rankRigid - rankOf(joined(withTurn));
            const bool turns = rigidInside > moves;

            // What is left of the freedom when the rigid motions are taken out: the free space minus its rigid part.
            Mat relative = free;
            if (rigidInside > 0) {
                Mat both(n, k + withTurn.cols());
                both << free, -withTurn;
                const Mat kernel = nullBasis(both, static_cast<int>(both.cols()));
                const Mat inside = columnBasis(free * kernel.topRows(k));
                relative = free - inside * (inside.transpose() * free);
            }
            relative = columnBasis(relative);
            const int kr = static_cast<int>(relative.cols());

            const std::string shape = classify(g, comp);
            std::vector<std::string> curves = comp.lines;
            curves.insert(curves.end(), comp.circles.begin(), comp.circles.end());
            std::set<std::string> endPoints;
            for (const std::string& id : comp.lines) {
                endPoints.insert(g.lines.at(id)->p1);
                endPoints.insert(g.lines.at(id)->p2);
            }
            if (moves > 0) {
                FreedomFact f{"position", shape, moves, curves};
                if (f.elements.empty()) f.elements = comp.points;
                report.facts.push_back(std::move(f));
            }
            if (turns) {
                FreedomFact f{"rotation", shape, 0, curves};
                if (f.elements.empty()) f.elements = comp.points;
                report.facts.push_back(std::move(f));
            }
            if (kr == 0) continue;

            const auto motion = [&](const std::string& pointId) -> std::pair<Row, Row> {
                if (!xIndex.count(pointId)) return {Row::Zero(kr), Row::Zero(kr)};
                return {relative.row(xIndex[pointId]), relative.row(yIndex[pointId])};
            };
            // Lines: the length and the direction of each line against the rest of the shape; the lines that change
            // together are one fact.
            struct Class {
                Row row;
                std::vector<std::string> ids;
            };
            std::vector<Class> lengths, directions, radii;
            const auto place = [](std::vector<Class>& classes, const Row& row, const std::string& id) {
                for (Class& c : classes)
                    if (parallelRows(c.row, row)) {
                        c.ids.push_back(id);
                        return;
                    }
                classes.push_back({row, {id}});
            };
            std::set<std::string> explained;
            for (const std::string& id : comp.lines) {
                const auto seg = g.ln(id);
                const Vec u = seg.b - seg.a;
                const double len = u.norm();
                if (len < 1e-12) continue;
                const Line* l = g.lines.at(id);
                const auto [ax, ay] = motion(l->p1);
                const auto [bx, by] = motion(l->p2);
                const Row dx = bx - ax, dy = by - ay;
                const Row lengthRow = (u.x() * dx + u.y() * dy) / len;
                const Row turnRow = (u.x() * dy - u.y() * dx) / len;  // the change of direction times the length
                if (lengthRow.norm() > kFree) place(lengths, lengthRow, id);
                if (turnRow.norm() > kFree) place(directions, turnRow, id);
                if (lengthRow.norm() > kFree || turnRow.norm() > kFree) {
                    explained.insert(l->p1);
                    explained.insert(l->p2);
                }
            }
            for (const std::string& id : comp.circles) {
                const Row radiusRow = relative.row(rIndex[id]);
                if (radiusRow.norm() > kFree) place(radii, radiusRow, id);
            }
            for (const Class& c : lengths) report.facts.push_back({"length", shape, 0, c.ids});
            for (const Class& c : directions) report.facts.push_back({"direction", shape, 0, c.ids});
            for (const Class& c : radii) report.facts.push_back({"radius", shape, 0, c.ids});
            // A point that moves against the rest and belongs to no line (a lone point, the centre of a circle).
            for (const std::string& id : comp.points) {
                if (endPoints.count(id) || explained.count(id)) continue;
                const auto [px, py] = motion(id);
                if (px.norm() > kFree || py.norm() > kFree) report.facts.push_back({"point", shape, 0, {id}});
            }
        }
    } catch (const std::exception&) {
        report.analysed = false;
        report.freeMotions = 0;
        report.facts.clear();
    }
    return report;
}

} // namespace hc::sketch
