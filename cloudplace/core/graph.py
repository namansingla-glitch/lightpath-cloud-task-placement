"""Weighted graph stored as adjacency lists.

Nodes are dense integer ids ``0..n-1`` (so arrays can be indexed directly) and
carry an attribute dict (name, coordinates, capacity, cost, ...).  Each
adjacency list ``adj[u]`` maps neighbour ``v`` to an :class:`Edge` record that
holds every weight attribute of the link (latency, bandwidth, transfer cost).

Space: Theta(V + E).  Neighbour iteration: O(deg(u)).  Edge lookup: O(1)
expected (each adjacency list is a hash map rather than a Python list, which
keeps parallel-edge handling and weight updates O(1) without changing the
asymptotics of any algorithm that scans neighbours).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

WeightFn = Callable[["Edge"], float]


@dataclass
class Edge:
    u: int
    v: int
    latency: float = 1.0          # one-way propagation + switching delay (ms)
    bandwidth: float = 10.0       # Gbit/s
    cost: float | None = None     # transfer cost; may be negative (rebate)
    attrs: dict[str, Any] = field(default_factory=dict)

    def weight(self, key: str = "latency") -> float:
        if key == "latency":
            return self.latency
        if key == "cost":
            return self.latency if self.cost is None else self.cost
        if key == "bandwidth":
            return self.bandwidth
        if key == "hops":
            return 1.0
        return float(self.attrs[key])


class Graph:
    """Adjacency-list graph (directed or undirected)."""

    def __init__(self, directed: bool = False) -> None:
        self.directed = directed
        self.nodes: list[dict[str, Any]] = []
        self.adj: list[dict[int, Edge]] = []
        self._m = 0

    # ------------------------------------------------------------------ build
    def add_node(self, **attrs: Any) -> int:
        nid = len(self.nodes)
        attrs.setdefault("name", f"n{nid}")
        self.nodes.append(attrs)
        self.adj.append({})
        return nid

    def add_edge(self, u: int, v: int, latency: float = 1.0, bandwidth: float = 10.0,
                 cost: float | None = None, **attrs: Any) -> None:
        if u == v:
            raise ValueError("self-loops are not allowed")
        for x in (u, v):
            if not 0 <= x < len(self.nodes):
                raise IndexError(f"unknown node {x}")
        new = v not in self.adj[u]
        self.adj[u][v] = Edge(u, v, latency, bandwidth, cost, dict(attrs))
        if not self.directed:
            self.adj[v][u] = Edge(v, u, latency, bandwidth, cost, dict(attrs))
        if new:
            self._m += 1

    def remove_edge(self, u: int, v: int) -> None:
        del self.adj[u][v]
        if not self.directed:
            del self.adj[v][u]
        self._m -= 1

    # ---------------------------------------------------------------- queries
    @property
    def n(self) -> int:
        return len(self.nodes)

    @property
    def m(self) -> int:
        return self._m

    def neighbors(self, u: int) -> Iterator[tuple[int, Edge]]:
        return iter(self.adj[u].items())

    def has_edge(self, u: int, v: int) -> bool:
        return v in self.adj[u]

    def edge(self, u: int, v: int) -> Edge:
        return self.adj[u][v]

    def edges(self) -> Iterator[Edge]:
        """Each undirected edge is yielded once (u < v)."""
        for u, nbrs in enumerate(self.adj):
            for v, e in nbrs.items():
                if self.directed or u < v:
                    yield e

    def degree(self, u: int) -> int:
        return len(self.adj[u])

    def density(self) -> float:
        n = self.n
        if n < 2:
            return 0.0
        possible = n * (n - 1) if self.directed else n * (n - 1) / 2
        return self.m / possible

    def has_negative_weights(self, key: str = "latency") -> bool:
        return any(e.weight(key) < 0 for e in self.edges())

    def is_connected(self) -> bool:
        if self.n == 0:
            return True
        seen = {0}
        stack = [0]
        und = self.to_undirected() if self.directed else self
        while stack:
            u = stack.pop()
            for v in und.adj[u]:
                if v not in seen:
                    seen.add(v)
                    stack.append(v)
        return len(seen) == self.n

    def components(self) -> list[list[int]]:
        und = self.to_undirected() if self.directed else self
        comp = [-1] * self.n
        out: list[list[int]] = []
        for s in range(self.n):
            if comp[s] != -1:
                continue
            cid = len(out)
            out.append([])
            stack = [s]
            comp[s] = cid
            while stack:
                u = stack.pop()
                out[cid].append(u)
                for v in und.adj[u]:
                    if comp[v] == -1:
                        comp[v] = cid
                        stack.append(v)
        return out

    # ------------------------------------------------------------ transforms
    def copy(self) -> "Graph":
        g = Graph(self.directed)
        for a in self.nodes:
            g.add_node(**dict(a))
        for e in self.edges():
            g.add_edge(e.u, e.v, e.latency, e.bandwidth, e.cost, **e.attrs)
        return g

    def to_undirected(self) -> "Graph":
        g = Graph(False)
        for a in self.nodes:
            g.add_node(**dict(a))
        for e in self.edges():
            if not g.has_edge(e.u, e.v) or g.edge(e.u, e.v).latency > e.latency:
                g.add_edge(e.u, e.v, e.latency, e.bandwidth, e.cost, **e.attrs)
        return g

    def to_directed(self) -> "Graph":
        g = Graph(True)
        for a in self.nodes:
            g.add_node(**dict(a))
        for u, nbrs in enumerate(self.adj):
            for v, e in nbrs.items():
                g.add_edge(u, v, e.latency, e.bandwidth, e.cost, **e.attrs)
        return g

    def subgraph_from_edges(self, edges: list[tuple[int, int]]) -> "Graph":
        g = Graph(self.directed)
        for a in self.nodes:
            g.add_node(**dict(a))
        for u, v in edges:
            e = self.adj[u][v]
            g.add_edge(u, v, e.latency, e.bandwidth, e.cost, **e.attrs)
        return g

    # ---------------------------------------------------------------- export
    def to_dict(self) -> dict[str, Any]:
        return {
            "directed": self.directed,
            "nodes": [{"id": i, **a} for i, a in enumerate(self.nodes)],
            "links": [
                {"u": e.u, "v": e.v, "latency": e.latency, "bandwidth": e.bandwidth,
                 **({"cost": e.cost} if e.cost is not None else {}), **e.attrs}
                for e in self.edges()
            ],
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Graph":
        g = cls(d.get("directed", False))
        nodes = sorted(d["nodes"], key=lambda x: x["id"])
        for i, a in enumerate(nodes):
            if a["id"] != i:
                raise ValueError("node ids must be 0..n-1")
            g.add_node(**{k: v for k, v in a.items() if k != "id"})
        for L in d["links"]:
            extra = {k: v for k, v in L.items() if k not in ("u", "v", "latency", "bandwidth", "cost")}
            g.add_edge(L["u"], L["v"], L.get("latency", 1.0), L.get("bandwidth", 10.0), L.get("cost"), **extra)
        return g

    def __repr__(self) -> str:
        kind = "Directed" if self.directed else "Undirected"
        return f"<{kind}Graph n={self.n} m={self.m}>"


def weight_fn(key: str = "latency") -> WeightFn:
    return lambda e: e.weight(key)
