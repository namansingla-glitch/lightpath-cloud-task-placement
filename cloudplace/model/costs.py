"""Directed transfer-cost graph (where negative edge weights come from).

Moving data u→v costs  c(u→v) = base + per_ms · latency(u,v)  $/GB.  Some
carriers pay *rebates* on specific peering arcs (traffic they want to attract),
giving c(u→v) = −rebate < 0 in that direction only.  Because the reverse arc
keeps its positive price and rebates are capped below it, every 2-cycle stays
non-negative; Bellman-Ford / Johnson still verify there is no negative cycle
before any route is trusted.

Dijkstra is *wrong* on this graph (it may settle a vertex before a cheaper
path through a rebate arc is found), which is exactly why the project uses
Bellman-Ford for single-source and Johnson for all-pairs transfer costs.
"""
from __future__ import annotations

from ..core.graph import Graph


def transfer_cost_graph(g: Graph, base: float = 0.01, per_ms: float = 0.002) -> Graph:
    """Directed graph whose 'cost' weight is $/GB; rebates read from link attr 'rebate_dir'."""
    d = Graph(directed=True)
    for a in g.nodes:
        d.add_node(**dict(a))
    for e in g.edges():
        price = round(base + per_ms * e.latency, 5)
        rebate = float(e.attrs.get("rebate", 0.0) or 0.0)
        rdir = e.attrs.get("rebate_dir")  # [from, to]
        c_uv = c_vu = price
        if rebate > 0 and rdir:
            a, b = int(rdir[0]), int(rdir[1])
            neg = -min(rebate, 0.9 * price)  # keep c(u->v) + c(v->u) > 0
            if (a, b) == (e.u, e.v):
                c_uv = round(neg, 5)
            elif (a, b) == (e.v, e.u):
                c_vu = round(neg, 5)
        d.add_edge(e.u, e.v, latency=e.latency, bandwidth=e.bandwidth, cost=c_uv)
        d.add_edge(e.v, e.u, latency=e.latency, bandwidth=e.bandwidth, cost=c_vu)
    return d
