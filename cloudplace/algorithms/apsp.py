"""All-pairs shortest paths: Floyd-Warshall, Johnson, repeated Dijkstra.

Floyd-Warshall — DP over intermediate vertices.  Let d_k(i,j) be the shortest
i->j distance using only intermediates from {0..k-1}.  Then
    d_{k+1}(i,j) = min(d_k(i,j), d_k(i,k) + d_k(k,j)),
because a shortest path either avoids k or passes through it exactly once
(no negative cycles).  Theta(V^3) time, Theta(V^2) space.  Negative weights
are fine; a negative diagonal entry certifies a negative cycle.

Johnson — add a virtual source q joined to every vertex with weight 0, run
Bellman-Ford from q to get potentials h(v), reweight
    w'(u,v) = w(u,v) + h(u) - h(v) >= 0   (triangle inequality on h),
then run Dijkstra from every vertex.  Every s->t path changes length by the
same constant h(s) - h(t), so shortest paths are preserved.
O(VE + V(V+E) log V) with a binary heap — better than V^3 on sparse graphs.

Choice rule (``apsp(..., algorithm="auto")``): Johnson / repeated Dijkstra when
E log V < V^2 (sparse), else Floyd-Warshall (dense, cache-friendly, and the
vectorised NumPy variant is very fast in practice).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..core.graph import Graph
from .sssp import NegativeCycleError, bellman_ford, dijkstra


@dataclass
class APSPResult:
    dist: np.ndarray            # (n, n) float, inf where unreachable
    nxt: np.ndarray             # (n, n) int next hop on a shortest path, -1 if none
    algorithm: str
    meta: dict[str, Any] = field(default_factory=dict)

    def path(self, u: int, v: int) -> list[int]:
        if u == v:
            return [u]
        if self.nxt[u, v] < 0:
            return []
        p = [u]
        guard = 0
        while u != v:
            u = int(self.nxt[u, v])
            p.append(u)
            guard += 1
            if guard > len(self.nxt):
                return []
        return p

    def to_dict(self) -> dict[str, Any]:
        d = np.where(np.isinf(self.dist), None, np.round(self.dist, 4))
        return {"algorithm": self.algorithm, "dist": d.tolist(), "meta": self.meta}


def _init(g: Graph, weight: str) -> tuple[list[list[float]], list[list[int]]]:
    n = g.n
    dist = [[math.inf] * n for _ in range(n)]
    nxt = [[-1] * n for _ in range(n)]
    for i in range(n):
        dist[i][i] = 0.0
        nxt[i][i] = i
    for u in range(n):
        for v, e in g.neighbors(u):
            w = e.weight(weight)
            if w < dist[u][v]:
                dist[u][v] = w
                nxt[u][v] = v
    return dist, nxt


def floyd_warshall(g: Graph, weight: str = "latency") -> APSPResult:
    """Textbook triple loop in pure Python (reference implementation)."""
    n = g.n
    dist, nxt = _init(g, weight)
    for k in range(n):
        dk = dist[k]
        for i in range(n):
            di = dist[i]
            dik = di[k]
            if dik == math.inf:
                continue
            ni = nxt[i]
            nik = ni[k]
            for j in range(n):
                cand = dik + dk[j]
                if cand < di[j]:
                    di[j] = cand
                    ni[j] = nik
    D = np.array(dist, dtype=float)
    if n and (np.diag(D) < 0).any():
        raise NegativeCycleError([int(np.argmin(np.diag(D)))])
    return APSPResult(D, np.array(nxt, dtype=int), "floyd_warshall")


def floyd_warshall_numpy(g: Graph, weight: str = "latency") -> APSPResult:
    """Same recurrence, k-loop in Python, (i,j) relaxation vectorised: still Theta(V^3)."""
    n = g.n
    dist, nxt = _init(g, weight)
    D = np.array(dist, dtype=float)
    N = np.array(nxt, dtype=int)
    for k in range(n):
        cand = D[:, k:k + 1] + D[k:k + 1, :]
        better = cand < D
        if better.any():
            D = np.where(better, cand, D)
            N = np.where(better, N[:, k:k + 1], N)
    if n and (np.diag(D) < 0).any():
        raise NegativeCycleError([int(np.argmin(np.diag(D)))])
    return APSPResult(D, N, "floyd_warshall_numpy")


def _from_parents(n: int, parents: list[list[int]]) -> np.ndarray:
    """Convert per-source shortest-path trees into a next-hop matrix."""
    N = np.full((n, n), -1, dtype=int)
    for s in range(n):
        par = parents[s]
        N[s, s] = s
        # next hop from s toward t = child of s on the tree path to t
        nh = [-1] * n
        nh[s] = s
        for t in range(n):
            if nh[t] != -1 or par[t] == -1:
                continue
            chain = []
            x = t
            while x != -1 and nh[x] == -1:
                chain.append(x)
                x = par[x]
            if x == -1:
                continue
            for y in reversed(chain):
                nh[y] = y if par[y] == s else nh[par[y]]
        N[s] = nh
    return N


def repeated_dijkstra(g: Graph, weight: str = "latency", heap: str = "binary") -> APSPResult:
    n = g.n
    D = np.full((n, n), math.inf)
    parents = []
    for s in range(n):
        r = dijkstra(g, s, weight, heap)
        D[s] = r.dist
        parents.append(r.parent)
    return APSPResult(D, _from_parents(n, parents), f"repeated_dijkstra[{heap}]")


def johnson(g: Graph, weight: str = "cost", heap: str = "binary") -> APSPResult:
    n = g.n
    if g.directed:
        h_graph = g.copy()
    else:
        h_graph = g.to_directed()
    # virtual source q = n
    q = h_graph.add_node(name="__q__")
    for v in range(n):
        h_graph.add_edge(q, v, latency=0.0, cost=0.0)
    bf = bellman_ford(h_graph, q, weight)  # raises NegativeCycleError
    h = bf.dist[:n]
    # reweighted graph (weights stored in 'latency' slot of a scratch graph)
    rw = Graph(directed=True)
    for _ in range(n):
        rw.add_node()
    for u in range(n):
        for v, e in g.neighbors(u):
            w2 = e.weight(weight) + h[u] - h[v]
            rw.add_edge(u, v, latency=max(0.0, w2))  # clamp float noise (>= -1e-12)
    D = np.full((n, n), math.inf)
    parents = []
    for s in range(n):
        r = dijkstra(rw, s, "latency", heap)
        parents.append(r.parent)
        for t in range(n):
            if r.dist[t] < math.inf:
                D[s, t] = r.dist[t] - h[s] + h[t]
    return APSPResult(D, _from_parents(n, parents), f"johnson[{heap}]",
                      {"potentials": [round(x, 6) for x in h]})


def choose_apsp(g: Graph, weight: str = "latency") -> str:
    n, m = g.n, g.m * (1 if g.directed else 2)
    negative = g.has_negative_weights(weight)
    sparse = m * math.log2(max(n, 2)) < n * n
    if negative:
        return "johnson" if sparse else "floyd_warshall_numpy"
    return "repeated_dijkstra" if sparse else "floyd_warshall_numpy"


def apsp(g: Graph, weight: str = "latency", algorithm: str = "auto", heap: str = "binary") -> APSPResult:
    alg = choose_apsp(g, weight) if algorithm == "auto" else algorithm
    if alg == "floyd_warshall":
        res = floyd_warshall(g, weight)
    elif alg == "floyd_warshall_numpy":
        res = floyd_warshall_numpy(g, weight)
    elif alg == "johnson":
        res = johnson(g, weight, heap)
    elif alg in ("dijkstra", "repeated_dijkstra"):
        res = repeated_dijkstra(g, weight, heap)
    else:
        raise ValueError(f"unknown APSP algorithm {alg}")
    res.meta["chosen_by"] = "auto" if algorithm == "auto" else "user"
    res.meta["density"] = round(g.density(), 5)
    return res
