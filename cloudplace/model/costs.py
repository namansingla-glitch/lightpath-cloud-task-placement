"""Directed transfer-cost graph (where negative edge weights come from).

Moving data u→v costs a base price that grows with latency, adjusted by a
regional *price level* φ at each end:

    c(u→v) = base + per_ms · latency(u,v) + φ(u) − φ(v)          ($/GB)

φ models transit markets: sending data into a site with a high price level
earns a rebate, so some arcs become negative.  Because the φ terms telescope
around any cycle, every cycle costs exactly the sum of its base prices,
which is positive: negative arcs exist, negative cycles cannot.  This is the
same potential-function argument that makes Johnson's reweighting correct.

Dijkstra is *wrong* on this graph (it may settle a vertex before a cheaper
path through a negative arc is found), which is exactly why the project uses
Bellman-Ford for single-source and Johnson for all-pairs transfer costs.
"""
from __future__ import annotations

import hashlib

from ..core.graph import Graph

TIER_LEVEL = {"core": 0.0, "regional": 0.35, "router": 0.55, "edge": 0.8}


def price_level(name: str, tier: str | None, scale: float) -> float:
    """Deterministic regional price level for a site."""
    jitter = int(hashlib.md5(name.encode()).hexdigest()[:6], 16) / 0xFFFFFF  # 0..1, stable across runs
    return round(scale * (0.7 * TIER_LEVEL.get(tier or "edge", 0.5) + 0.3 * jitter), 5)


def transfer_cost_graph(g: Graph, base: float = 0.01, per_ms: float = 0.002, level_scale: float = 0.08) -> Graph:
    """Directed graph whose 'cost' weight is $/GB, with negative arcs but no negative cycles."""
    d = Graph(directed=True)
    phi = []
    for a in g.nodes:
        d.add_node(**dict(a))
        phi.append(price_level(str(a.get("name", "")), a.get("tier"), level_scale))
    for e in g.edges():
        price = base + per_ms * e.latency
        d.add_edge(e.u, e.v, latency=e.latency, bandwidth=e.bandwidth, cost=round(price + phi[e.u] - phi[e.v], 6))
        d.add_edge(e.v, e.u, latency=e.latency, bandwidth=e.bandwidth, cost=round(price + phi[e.v] - phi[e.u], 6))
    return d
