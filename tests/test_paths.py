import math

import networkx as nx
import numpy as np
import pytest

from cloudplace.algorithms import (NegativeCycleError, apsp, bellman_ford, choose_apsp, dijkstra,
                                   floyd_warshall, floyd_warshall_numpy, johnson, kruskal, mst, prim,
                                   repeated_dijkstra)
from cloudplace.core import HEAPS, Graph
from cloudplace.model import transfer_cost_graph
from cloudplace.data import build_instance
from conftest import random_graph, to_nx

CASES = [(n, p, s) for n, p in [(2, 1.0), (8, 0.3), (25, 0.15), (60, 0.05), (40, 0.6)] for s in range(3)]


# ------------------------------------------------------------------- MST
@pytest.mark.parametrize("n,p,seed", CASES)
def test_mst_weight_matches_networkx(n, p, seed):
    g = random_graph(n, p, seed)
    ref = sum(d["weight"] for *_, d in nx.minimum_spanning_edges(to_nx(g), data=True))
    for heap in HEAPS:
        r = prim(g, heap=heap)
        assert r.total_weight == pytest.approx(ref)
        assert len(r.edges) == n - 1 and r.is_spanning_tree
    k = kruskal(g)
    assert k.total_weight == pytest.approx(ref)
    # result is a tree: n-1 edges and connected
    t = g.subgraph_from_edges([(u, v) for u, v, _ in k.edges])
    assert t.is_connected()


def test_mst_forest_on_disconnected_graph():
    g = random_graph(10, 0.0, 0, connected=False)
    for i in range(0, 8, 2):
        g.add_edge(i, i + 1, latency=1.0)
    assert prim(g).components == kruskal(g).components == 6
    assert prim(g).total_weight == kruskal(g).total_weight == 4.0


def test_mst_trace_and_auto():
    g = random_graph(12, 0.4, 1)
    r = prim(g, trace=True)
    assert sum(1 for s in r.trace if s["type"] == "add_edge") == 11
    k = kruskal(g, trace=True)
    assert any(s["type"] == "reject_cycle" for s in k.trace)
    assert mst(g).total_weight == pytest.approx(k.total_weight)


# ------------------------------------------------------------------- SSSP
@pytest.mark.parametrize("n,p,seed", CASES)
def test_dijkstra_matches_networkx(n, p, seed):
    g = random_graph(n, p, seed)
    ref = nx.single_source_dijkstra_path_length(to_nx(g), 0)
    for heap in HEAPS:
        r = dijkstra(g, 0, heap=heap)
        for v in range(n):
            assert r.dist[v] == pytest.approx(ref[v])
        # reconstructed paths have the reported length
        for v in range(n):
            path = r.path_to(v)
            assert path[0] == 0 and path[-1] == v
            assert sum(g.edge(a, b).latency for a, b in zip(path, path[1:])) == pytest.approx(r.dist[v])


def test_dijkstra_unreachable_and_negative():
    g = random_graph(5, 0.0, 0, connected=False)
    g.add_edge(0, 1, latency=2)
    r = dijkstra(g, 0)
    assert math.isinf(r.dist[3]) and r.path_to(3) == []
    g.add_edge(1, 2, latency=-1)
    with pytest.raises(ValueError):
        dijkstra(g, 0)


@pytest.mark.parametrize("seed", range(6))
def test_bellman_ford_negative_weights(seed):
    g = random_graph(30, 0.15, seed, directed=True, neg=0.3)
    assert g.has_negative_weights("cost")
    G = to_nx(g, "cost")
    ref = nx.single_source_bellman_ford_path_length(G, 0)
    r = bellman_ford(g, 0, "cost")
    for v in range(g.n):
        if v in ref:
            assert r.dist[v] == pytest.approx(ref[v])
        else:
            assert math.isinf(r.dist[v])


def test_bellman_ford_detects_negative_cycle():
    g = Graph(directed=True)
    for _ in range(4):
        g.add_node()
    g.add_edge(0, 1, cost=1)
    g.add_edge(1, 2, cost=-2)
    g.add_edge(2, 3, cost=-2)
    g.add_edge(3, 1, cost=1)
    with pytest.raises(NegativeCycleError) as ei:
        bellman_ford(g, 0, "cost")
    cyc = ei.value.cycle
    assert cyc[0] == cyc[-1] and set(cyc) == {1, 2, 3}
    with pytest.raises(NegativeCycleError):
        johnson(g, "cost")


# ------------------------------------------------------------------- APSP
@pytest.mark.parametrize("n,p,seed", CASES[:12])
def test_apsp_all_algorithms_agree(n, p, seed):
    g = random_graph(n, p, seed)
    ref = dict(nx.all_pairs_dijkstra_path_length(to_nx(g)))
    R = np.array([[ref[i][j] for j in range(n)] for i in range(n)])
    for res in (floyd_warshall(g), floyd_warshall_numpy(g), johnson(g, "latency"), repeated_dijkstra(g),
                repeated_dijkstra(g, heap="fibonacci"), apsp(g)):
        assert np.allclose(res.dist, R), res.algorithm
        for u in range(0, n, max(1, n // 5)):
            for v in range(n):
                path = res.path(u, v)
                assert path[0] == u and path[-1] == v
                assert sum(g.edge(a, b).latency for a, b in zip(path, path[1:])) == pytest.approx(R[u, v])


@pytest.mark.parametrize("seed", range(4))
def test_johnson_and_fw_with_negative_arcs(seed):
    g = random_graph(25, 0.2, seed, directed=True, neg=0.25)
    ref = dict(nx.johnson(to_nx(g, "cost")))
    G = to_nx(g, "cost")
    j = johnson(g, "cost")
    fw = floyd_warshall_numpy(g, "cost")
    for u in range(g.n):
        for v in range(g.n):
            if v in ref.get(u, {}):
                exp = nx.path_weight(G, ref[u][v], "weight")
                assert j.dist[u, v] == pytest.approx(exp)
                assert fw.dist[u, v] == pytest.approx(exp)
            else:
                assert math.isinf(j.dist[u, v])


def test_apsp_auto_choice():
    sparse = random_graph(80, 0.02, 0)
    dense = random_graph(40, 0.9, 0)
    assert choose_apsp(sparse) == "repeated_dijkstra"
    assert choose_apsp(dense) == "floyd_warshall_numpy"
    neg = random_graph(80, 0.02, 0, directed=True, neg=0.2)
    assert choose_apsp(neg, "cost") == "johnson"


def test_transfer_cost_graph_has_negative_arcs_but_no_negative_cycle():
    inst = build_instance("waxman", n=40, seed=3)
    tg = transfer_cost_graph(inst.graph)
    assert tg.directed and tg.has_negative_weights("cost")
    with pytest.raises(ValueError):
        dijkstra(tg, 0, "cost")
    bf = bellman_ford(tg, 0, "cost")  # must not raise
    jr = johnson(tg, "cost")
    assert np.allclose(jr.dist[0], bf.dist)


@pytest.mark.parametrize("model", ["india", "nigeria", "woxsen", "abilene", "nsfnet", "waxman", "barabasi_albert", "fat_tree"])
def test_transfer_costs_never_have_negative_cycles(model):
    inst = build_instance(model, n=60, seed=11)
    tg = transfer_cost_graph(inst.graph)
    assert tg.has_negative_weights("cost")          # rebates exist...
    j = johnson(tg, "cost")                          # ...but Johnson never finds a negative cycle
    for s in range(0, inst.graph.n, 7):
        bf = bellman_ford(tg, s, "cost")
        assert np.allclose(j.dist[s], bf.dist)
