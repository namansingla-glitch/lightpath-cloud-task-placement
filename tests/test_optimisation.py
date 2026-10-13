import itertools
import json
import random

import numpy as np
import pytest

from cloudplace.algorithms import (GREEDY, PlacementContext, apsp, fractional_knapsack_bound, knapsack_01,
                                   local_search, multiple_choice_knapsack, schedule_batch, solve_exact)
from cloudplace.algorithms.placement import Placement
from cloudplace.core import Graph
from cloudplace.data import build_instance
from cloudplace.model import Instance, Service
from cloudplace.solver import SolveConfig, solve


# --------------------------------------------------------------- knapsack
@pytest.mark.parametrize("seed", range(40))
def test_knapsack_01_matches_brute_force(seed):
    rng = random.Random(seed)
    n = rng.randint(0, 11)
    vals = [rng.randint(0, 30) for _ in range(n)]
    wts = [rng.randint(0, 12) for _ in range(n)]
    cap = rng.randint(0, 40)
    best = 0
    for mask in range(1 << n):
        w = sum(wts[i] for i in range(n) if mask >> i & 1)
        if w <= cap:
            best = max(best, sum(vals[i] for i in range(n) if mask >> i & 1))
    r = knapsack_01(vals, wts, cap)
    assert r.value == best
    assert r.weight <= cap
    assert r.value == sum(vals[i] for i in r.chosen)
    assert fractional_knapsack_bound(vals, wts, cap) >= best - 1e-9


def test_knapsack_fractional_costs_resolution():
    r = knapsack_01([10, 7, 4], [0.35, 0.25, 0.15], 0.5, resolution=0.01)
    assert r.chosen == [0, 2] and r.value == 14


@pytest.mark.parametrize("seed", range(30))
def test_mckp_matches_brute_force(seed):
    rng = random.Random(seed)
    groups = [[(rng.randint(0, 20), rng.randint(1, 8)) for _ in range(rng.randint(1, 4))]
              for _ in range(rng.randint(1, 4))]
    cap = rng.randint(0, 25)
    best = None
    for combo in itertools.product(*[range(len(g)) for g in groups]):
        w = sum(groups[i][c][1] for i, c in enumerate(combo))
        v = sum(groups[i][c][0] for i, c in enumerate(combo))
        if w <= cap and (best is None or v > best):
            best = v
    r = multiple_choice_knapsack(groups, cap)
    if best is None:
        assert not r.feasible
    else:
        assert r.feasible and r.value == best and r.weight <= cap


# -------------------------------------------------------------- placement
def tiny_instance(seed: int, cap: int = 8) -> Instance:
    rng = random.Random(seed)
    g = Graph()
    n = 7
    for i in range(n):
        g.add_node(name=f"s{i}", x=rng.uniform(0, 1000), y=rng.uniform(0, 1000), cpu=cap, mem=4 * cap, cost=1.0)
    for i in range(1, n):
        g.add_edge(rng.randrange(i), i, latency=rng.uniform(1, 10))
    for _ in range(4):
        u, v = rng.sample(range(n), 2)
        if not g.has_edge(u, v):
            g.add_edge(u, v, latency=rng.uniform(1, 10))
    svcs = []
    for j in range(3):
        dem = {c: rng.uniform(1, 10) for c in rng.sample(range(n), 4)}
        svcs.append(Service(j, f"svc{j}", cpu=rng.choice([2, 4]), mem=4, demand=dem, min_replicas=1,
                            max_replicas=2))
    return Instance("tiny", g, svcs)


def brute_force(ctx: PlacementContext, targets):
    S = [int(s) for s in ctx.servers]
    opts = [list(itertools.combinations(S, k)) for k in targets]
    best = None
    for combo in itertools.product(*opts):
        p = Placement({j: list(c) for j, c in enumerate(combo)})
        if ctx.check(p, targets):
            continue
        v = ctx.objective(p)
        if best is None or v < best:
            best = v
    return best


@pytest.mark.parametrize("seed", range(8))
def test_exact_milp_equals_brute_force_and_bounds_heuristics(seed):
    inst = tiny_instance(seed, cap=4)
    D = apsp(inst.graph).dist
    ctx = PlacementContext(inst, D)
    targets = [2, 1, 2]
    bf = brute_force(ctx, targets)
    ex = solve_exact(ctx, targets)
    if bf is None:
        assert not ex.feasible
        return
    assert ctx.objective(ex) == pytest.approx(bf, abs=1e-6)
    assert ex.stats["objective"] == pytest.approx(bf, abs=1e-6)
    lp = solve_exact(ctx, targets, relax=True)
    assert lp.stats["objective"] <= bf + 1e-6
    for name, fn in GREEDY.items():
        p = fn(ctx, targets)
        if p.feasible:
            assert not ctx.check(p, targets)
            assert ctx.objective(p) >= bf - 1e-9
            q = local_search(ctx, p)
            assert not ctx.check(q, targets)
            assert ctx.objective(q) <= ctx.objective(p) + 1e-9
            assert ctx.objective(q) >= bf - 1e-9


def test_objective_by_hand():
    g = Graph()
    for i in range(3):
        g.add_node(cpu=4, mem=8)
    g.add_edge(0, 1, latency=2)
    g.add_edge(1, 2, latency=3)
    inst = Instance("line", g, [Service(0, "a", 1, 1, {0: 1.0, 2: 3.0})])
    ctx = PlacementContext(inst, apsp(g).dist)
    # replica at 1: (1*2 + 3*3)/4 = 2.75 ; at 2: (1*5 + 0)/4 = 1.25
    assert ctx.objective(Placement({0: [1]})) == pytest.approx(2.75)
    assert ctx.objective(Placement({0: [2]})) == pytest.approx(1.25)
    best = solve_exact(ctx, [1])
    assert best.replicas[0] == [2]


@pytest.mark.parametrize("model", ["waxman", "barabasi_albert", "erdos_renyi"])
@pytest.mark.parametrize("cf", [0.4, 1.0])
def test_greedies_respect_capacity(model, cf):
    inst = build_instance(model, n=40, seed=5, services=10, capacity_factor=cf)
    ctx = PlacementContext(inst, apsp(inst.graph).dist)
    targets = [s.min_replicas for s in inst.services]
    for name, fn in GREEDY.items():
        p = fn(ctx, targets)
        errs = ctx.check(p)
        assert not errs, (name, errs)  # never over capacity, even if incomplete
        if p.feasible:
            q = local_search(ctx, p)
            assert not ctx.check(q, targets)


def test_infeasible_capacity_is_reported_not_crashing():
    inst = build_instance("abilene", seed=1, services=12, capacity_factor=0.1)
    out = solve(inst, SolveConfig(exact="never"))
    json.dumps(out)
    assert any(not s["feasible"] for s in out["strategies"]) or out["warnings"]


# --------------------------------------------------------------- scheduler
def test_batch_schedule_lanes_never_overlap():
    inst = build_instance("india", seed=2, tasks=40)
    D = apsp(inst.graph).dist
    sch = schedule_batch(inst, D, None, "lpt")
    assert len(sch.entries) == 40
    lanes: dict = {}
    for e in sch.entries:
        assert e["end"] - e["start"] == pytest.approx(next(t.duration for t in inst.tasks if t.id == e["task"]),
                                                     abs=1e-3)
        assert e["start"] + 1e-9 >= e["transfer"]
        lanes.setdefault((e["server"], e["lane"]), []).append((e["start"], e["end"]))
    for iv in lanes.values():
        iv.sort()
        for a, b in zip(iv, iv[1:]):
            assert a[1] <= b[0] + 1e-9
    assert sch.makespan == max(e["end"] for e in sch.entries)


# --------------------------------------------------------------- pipeline
@pytest.mark.parametrize("model", ["abilene", "nsfnet", "india", "campus", "fat_tree", "waxman"])
def test_solve_pipeline_end_to_end(model):
    inst = build_instance(model, n=30, seed=4)
    assert not inst.validate()
    out = solve(inst, SolveConfig(server_budget=None))
    s = json.dumps(out)
    assert len(s) > 1000
    names = {r["name"] for r in out["strategies"]}
    assert {"random", "marginal_gain", "marginal_gain+ls", "regret", "exact_milp"} <= names
    ex = out["exact"]["objective"]
    for r in out["strategies"]:
        if r["feasible"]:
            assert r["mean_ms"] >= ex - 1e-6
    assert out["sizing"]["spend"] <= out["sizing"]["budget"] + 1e-9
    assert out["policy"]["routes"] and out["policy"]["schedule"] and out["recommendations"]
    assert out["policy"]["batch"]["makespan"] > 0


def test_solve_with_server_activation_budget():
    inst = build_instance("waxman", n=40, seed=2, services=6)
    total = sum(inst.server_cost(s) for s in inst.servers)
    out = solve(inst, SolveConfig(server_budget=round(total * 0.4, 2)))
    act = out["activation"]
    assert len(act["chosen"]) < len(inst.servers)
    best = next(r for r in out["strategies"] if r["name"] == out["best"])
    used = {s for S in best["replicas"].values() for s in S}
    assert used <= set(act["chosen"])


def test_mckp_sizing_monotone_in_budget():
    inst = build_instance("nsfnet", seed=3)
    prev = None
    for b in [1.0, 2.0, 4.0, 8.0]:
        out = solve(inst, SolveConfig(vm_budget=b, exact="never", include_routes=False))
        mean = min(r["mean_ms"] for r in out["strategies"] if r["feasible"] and r["name"] != "random")
        if prev is not None:
            assert mean <= prev + 0.75  # more budget never makes the plan materially worse
        prev = mean


def test_exact_handles_unhostable_service():
    inst = build_instance("waxman", n=50, seed=0, services=12, tasks=0, capacity_factor=0.25)
    from cloudplace.solver import size_replicas
    ctx = PlacementContext(inst, apsp(inst.graph).dist)
    t = size_replicas(ctx, inst.budget)["targets"]
    assert 0 in t
    ex = solve_exact(ctx, t, time_limit_s=30)
    assert ex.feasible and not ctx.check(ex, t)
    assert ex.stats["objective"] == pytest.approx(ctx.objective(ex), rel=1e-6)
    p = GREEDY["ffd_pack"](ctx, t)
    assert p.feasible and ctx.objective(p) >= ctx.objective(ex) - 1e-9
