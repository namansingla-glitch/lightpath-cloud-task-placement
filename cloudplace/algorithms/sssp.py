"""Single-source shortest paths: Dijkstra and Bellman-Ford.

Dijkstra — requires w(e) >= 0.  Invariant: when u is extracted from the heap,
dist[u] equals the true distance delta(s,u).  Proof sketch: suppose u is the
first extracted vertex with dist[u] > delta(s,u); take a shortest s->u path
and its first vertex y not yet extracted, with predecessor x already extracted.
Then dist[y] = delta(s,y) <= delta(s,u) < dist[u] (non-negative weights), so
y would have been extracted before u — contradiction.
    Time: O((V+E) log V) binary heap, O(E + V log V) Fibonacci heap.

Bellman-Ford — handles negative weights.  After i rounds of relaxing every
edge, dist[v] <= weight of the shortest s->v path that uses <= i edges.  A
shortest simple path has <= V-1 edges, so V-1 rounds suffice; if a V-th round
still relaxes an edge, a negative cycle is reachable from s.
    Time: O(VE) worst case (early exit when a round makes no change).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from ..core.graph import Graph
from ..core.heaps import make_heap


class NegativeCycleError(ValueError):
    def __init__(self, cycle: list[int]) -> None:
        super().__init__(f"negative-weight cycle detected: {cycle}")
        self.cycle = cycle


@dataclass
class SSSPResult:
    source: int
    dist: list[float]
    parent: list[int]
    algorithm: str
    relaxations: int = 0
    trace: list[dict[str, Any]] = field(default_factory=list)

    def path_to(self, t: int) -> list[int]:
        return reconstruct_path(self.parent, self.source, t)

    def to_dict(self) -> dict[str, Any]:
        return {
            "algorithm": self.algorithm,
            "source": self.source,
            "dist": [None if math.isinf(d) else d for d in self.dist],
            "parent": self.parent,
            "relaxations": self.relaxations,
            "trace": self.trace,
        }


def reconstruct_path(parent: list[int], s: int, t: int) -> list[int]:
    if s == t:
        return [s]
    if parent[t] == -1:
        return []
    path = [t]
    seen = {t}
    while path[-1] != s:
        p = parent[path[-1]]
        if p == -1 or p in seen:
            return []
        path.append(p)
        seen.add(p)
    path.reverse()
    return path


def dijkstra(g: Graph, source: int, weight: str = "latency", heap: str = "binary",
             target: int | None = None, trace: bool = False) -> SSSPResult:
    n = g.n
    dist = [math.inf] * n
    parent = [-1] * n
    done = [False] * n
    dist[source] = 0.0
    pq = make_heap(heap)
    pq.push(source, 0.0)
    relax = 0
    steps: list[dict[str, Any]] = []
    while len(pq):
        u, du = pq.pop()
        done[u] = True
        if trace:
            steps.append({"type": "settle", "u": u, "d": du})
        if u == target:
            break
        for v, e in g.neighbors(u):
            if done[v]:
                continue
            w = e.weight(weight)
            if w < 0:
                raise ValueError(f"Dijkstra requires non-negative weights (edge {u}->{v} = {w}); "
                                 "use bellman_ford or johnson")
            nd = du + w
            if nd < dist[v]:
                dist[v] = nd
                parent[v] = u
                pq.push_or_decrease(v, nd)
                relax += 1
                if trace:
                    steps.append({"type": "relax", "u": u, "v": v, "d": nd})
    return SSSPResult(source, dist, parent, f"dijkstra[{heap}]", relax, steps)


def bellman_ford(g: Graph, source: int, weight: str = "cost", trace: bool = False) -> SSSPResult:
    n = g.n
    dist = [math.inf] * n
    parent = [-1] * n
    dist[source] = 0.0
    arcs = [(u, v, e.weight(weight)) for u in range(n) for v, e in g.neighbors(u)]
    relax = 0
    steps: list[dict[str, Any]] = []
    for rnd in range(max(n - 1, 0)):
        changed = False
        for u, v, w in arcs:
            if dist[u] + w < dist[v]:
                dist[v] = dist[u] + w
                parent[v] = u
                changed = True
                relax += 1
                if trace:
                    steps.append({"type": "relax", "round": rnd, "u": u, "v": v, "d": dist[v]})
        if not changed:
            break
    else:
        # V-th pass: any further improvement certifies a negative cycle
        for u, v, w in arcs:
            if dist[u] + w < dist[v]:
                parent[v] = u
                raise NegativeCycleError(_extract_cycle(parent, v, n))
    return SSSPResult(source, dist, parent, "bellman_ford", relax, steps)


def _extract_cycle(parent: list[int], v: int, n: int) -> list[int]:
    for _ in range(n):  # walk back n steps to land inside the cycle
        v = parent[v]
    cycle = [v]
    u = parent[v]
    while u != v:
        cycle.append(u)
        u = parent[u]
    cycle.append(v)
    cycle.reverse()
    return cycle


def sssp(g: Graph, source: int, weight: str = "latency", **kw: Any) -> SSSPResult:
    """Dispatch: Dijkstra if all weights are non-negative, else Bellman-Ford."""
    if g.has_negative_weights(weight):
        return bellman_ford(g, source, weight, trace=kw.get("trace", False))
    return dijkstra(g, source, weight, **kw)
