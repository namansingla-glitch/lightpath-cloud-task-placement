"""Minimum spanning tree / forest: Prim and Kruskal.

The MST of the latency graph is the cheapest set of links that keeps every
server reachable — it is the *backbone* we provision first.  By the cut
property it also minimises the bottleneck (max-latency) link of any spanning
tree, i.e. it is a minimum bottleneck spanning tree.

Correctness (both): the *cut property* — for any cut (S, V\\S), a lightest
edge crossing it belongs to some MST.  Prim grows one tree and always adds the
lightest edge leaving it (a cut); Kruskal adds the globally lightest edge that
joins two different components (lightest edge across the cut separating one
of those components from the rest).

Complexity:
    Prim (binary heap)     O((V + E) log V)
    Prim (Fibonacci heap)  O(E + V log V)
    Kruskal                O(E log E) for the sort + O(E alpha(V)) union-find
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from ..core.graph import Graph
from ..core.heaps import make_heap
from ..core.unionfind import UnionFind


@dataclass
class MSTResult:
    edges: list[tuple[int, int, float]]
    total_weight: float
    algorithm: str
    components: int = 1
    trace: list[dict[str, Any]] = field(default_factory=list)

    @property
    def is_spanning_tree(self) -> bool:
        return self.components == 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "algorithm": self.algorithm,
            "edges": [{"u": u, "v": v, "w": w} for u, v, w in self.edges],
            "total_weight": self.total_weight,
            "components": self.components,
            "trace": self.trace,
        }


def prim(g: Graph, weight: str = "latency", heap: str = "binary", root: int = 0,
         trace: bool = False) -> MSTResult:
    if g.directed:
        raise ValueError("MST is defined on undirected graphs; call g.to_undirected()")
    n = g.n
    in_tree = [False] * n
    best = [math.inf] * n
    via = [-1] * n
    edges: list[tuple[int, int, float]] = []
    steps: list[dict[str, Any]] = []
    comps = 0
    order = [root] + [v for v in range(n) if v != root] if n else []
    for start in order:  # outer loop handles disconnected graphs (spanning forest)
        if in_tree[start]:
            continue
        comps += 1
        pq = make_heap(heap)
        best[start] = 0.0
        pq.push(start, 0.0)
        while len(pq):
            u, _ = pq.pop()
            in_tree[u] = True
            if via[u] != -1:
                edges.append((via[u], u, best[u]))
                if trace:
                    steps.append({"type": "add_edge", "u": via[u], "v": u, "w": best[u]})
            elif trace:
                steps.append({"type": "visit", "u": u})
            for v, e in g.neighbors(u):
                if in_tree[v]:
                    continue
                w = e.weight(weight)
                if trace:
                    steps.append({"type": "consider", "u": u, "v": v, "w": w})
                if w < best[v]:
                    best[v] = w
                    via[v] = u
                    pq.push_or_decrease(v, w)
                    if trace:
                        steps.append({"type": "relax", "u": u, "v": v, "w": w})
    total = sum(w for _, _, w in edges)
    return MSTResult(edges, total, f"prim[{heap}]", comps, steps)


def kruskal(g: Graph, weight: str = "latency", trace: bool = False) -> MSTResult:
    if g.directed:
        raise ValueError("MST is defined on undirected graphs; call g.to_undirected()")
    uf = UnionFind(g.n)
    candidates = sorted(((e.weight(weight), e.u, e.v) for e in g.edges()))
    edges: list[tuple[int, int, float]] = []
    steps: list[dict[str, Any]] = []
    for w, u, v in candidates:
        if uf.union(u, v):
            edges.append((u, v, w))
            if trace:
                steps.append({"type": "add_edge", "u": u, "v": v, "w": w})
            if len(edges) == g.n - 1:
                break
        elif trace:
            steps.append({"type": "reject_cycle", "u": u, "v": v, "w": w})
    total = sum(w for _, _, w in edges)
    return MSTResult(edges, total, "kruskal", uf.count, steps)


def mst(g: Graph, algorithm: str = "auto", weight: str = "latency", **kw: Any) -> MSTResult:
    """Pick Prim for dense graphs (E close to V^2), Kruskal for sparse ones."""
    if algorithm == "auto":
        algorithm = "prim" if g.m > g.n * max(1.0, math.log2(max(g.n, 2))) else "kruskal"
    if algorithm == "prim":
        return prim(g, weight, **kw)
    if algorithm == "kruskal":
        return kruskal(g, weight, **{k: v for k, v in kw.items() if k == "trace"})
    raise ValueError(f"unknown MST algorithm {algorithm}")
