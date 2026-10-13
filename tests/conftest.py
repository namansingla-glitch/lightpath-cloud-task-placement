import random
import sys
from pathlib import Path

import networkx as nx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cloudplace.core import Graph  # noqa: E402


def random_graph(n: int, p: float, seed: int, directed: bool = False, neg: float = 0.0,
                 connected: bool = True) -> Graph:
    rng = random.Random(seed)
    g = Graph(directed)
    for i in range(n):
        g.add_node(name=str(i), x=0, y=0)
    if connected and n > 1:
        for i in range(1, n):
            j = rng.randrange(i)
            g.add_edge(j, i, latency=round(rng.uniform(1, 20), 3))
    for u in range(n):
        for v in range(n):
            if u == v or (not directed and v < u) or g.has_edge(u, v):
                continue
            if rng.random() < p:
                w = round(rng.uniform(1, 20), 3)
                g.add_edge(u, v, latency=w, cost=w)
    if neg and directed:
        # negative arcs without negative cycles: reweight by a random potential phi.
        # w'(u,v) = w(u,v) + phi(u) - phi(v) leaves every cycle's weight unchanged (> 0),
        # yet makes many individual arcs negative.
        phi = [rng.uniform(0, 40 * neg) for _ in range(n)]
        for u in range(n):
            for v, e in g.adj[u].items():
                e.cost = round(e.latency + phi[u] - phi[v], 6)
                e.latency = e.cost
    return g


def to_nx(g: Graph, key: str = "latency") -> nx.Graph:
    G = nx.DiGraph() if g.directed else nx.Graph()
    G.add_nodes_from(range(g.n))
    for e in g.edges():
        G.add_edge(e.u, e.v, weight=e.weight(key))
    return G


@pytest.fixture
def rg():
    return random_graph
