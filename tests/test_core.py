import random

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from cloudplace.core import HEAPS, Graph, UnionFind


@pytest.mark.parametrize("kind", sorted(HEAPS))
def test_heap_random_ops_match_reference(kind):
    for seed in range(50):
        rng = random.Random(seed)
        h = HEAPS[kind]()
        ref: dict[int, float] = {}
        nxt = 0
        for _ in range(400):
            r = rng.random()
            if r < 0.45:
                k = rng.uniform(0, 100)
                h.push(nxt, k)
                ref[nxt] = k
                nxt += 1
            elif r < 0.75 and ref:
                it = rng.choice(list(ref))
                k = ref[it] - rng.uniform(0, 30)
                h.decrease_key(it, k)
                ref[it] = k
            elif ref:
                it, k = h.pop()
                assert k == min(ref.values())
                assert ref.pop(it) == k
            assert len(h) == len(ref)
        out = []
        while len(h):
            out.append(h.pop()[1])
        assert out == sorted(ref.values())


@pytest.mark.parametrize("kind", sorted(HEAPS))
@settings(max_examples=60, deadline=None)
@given(keys=st.lists(st.floats(-1e6, 1e6, allow_nan=False), min_size=0, max_size=80))
def test_heap_sort_property(kind, keys):
    h = HEAPS[kind]()
    for i, k in enumerate(keys):
        h.push(i, k)
    assert [h.pop()[1] for _ in range(len(keys))] == sorted(keys)


@pytest.mark.parametrize("kind", sorted(HEAPS))
def test_heap_errors(kind):
    h = HEAPS[kind]()
    with pytest.raises(IndexError):
        h.pop()
    h.push("a", 5)
    with pytest.raises(KeyError):
        h.push("a", 1)
    with pytest.raises(ValueError):
        h.decrease_key("a", 10)
    assert h.push_or_decrease("a", 3) is True
    assert h.push_or_decrease("a", 4) is False
    assert h.peek() == ("a", 3)


def test_unionfind():
    uf = UnionFind(6)
    assert uf.union(0, 1) and uf.union(2, 3) and uf.union(1, 3)
    assert not uf.union(0, 2)
    assert uf.connected(0, 3) and not uf.connected(0, 4)
    assert uf.count == 3
    assert uf.size[uf.find(0)] == 4


def test_graph_basics_and_roundtrip():
    g = Graph()
    a = g.add_node(name="A", cpu=8)
    b = g.add_node(name="B")
    c = g.add_node(name="C")
    g.add_edge(a, b, latency=2.5, bandwidth=40)
    g.add_edge(b, c, latency=1.0, cost=-0.5)
    assert g.n == 3 and g.m == 2
    assert g.has_edge(b, a) and g.edge(b, a).latency == 2.5
    assert g.degree(b) == 2
    assert g.is_connected()
    assert g.has_negative_weights("cost") and not g.has_negative_weights("latency")
    g.add_edge(a, b, latency=3.0)  # overwrite does not double count
    assert g.m == 2 and g.edge(a, b).latency == 3.0
    h = Graph.from_dict(g.to_dict())
    assert h.n == 3 and h.m == 2 and h.edge(c, b).cost == -0.5 and h.nodes[0]["cpu"] == 8
    with pytest.raises(ValueError):
        g.add_edge(a, a)
    with pytest.raises(IndexError):
        g.add_edge(a, 99)
    g.remove_edge(a, b)
    assert not g.is_connected() and len(g.components()) == 2


def test_directed_graph():
    g = Graph(directed=True)
    for _ in range(3):
        g.add_node()
    g.add_edge(0, 1, latency=1)
    assert g.has_edge(0, 1) and not g.has_edge(1, 0)
    assert g.density() == pytest.approx(1 / 6)
    u = g.to_undirected()
    assert u.has_edge(1, 0)
