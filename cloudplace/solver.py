"""End-to-end placement pipeline and policy outputs.

    1  Topology      APSP latency matrix (auto: Floyd-Warshall vs Johnson /
                     repeated Dijkstra) + MST backbone (Prim / Kruskal).
    2  Activation    0/1 knapsack DP: which servers to keep powered under a
                     server budget (optional).
    3  Sizing        multiple-choice knapsack DP: replica count per service
                     under the VM budget.
    4  Placement     greedy schedulers (demand_first, marginal_gain, regret).
    5  Refinement    relocate/swap local search.
    6  Exact         MILP optimum on small instances -> optimality gap.
    7  Policies      route table, server schedule, cost/benefit table,
                     replication transfer routes (Bellman-Ford/Johnson with
                     negative rebate arcs), batch Gantt, recommendations.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .algorithms.apsp import APSPResult, apsp, johnson
from .algorithms.exact import solve_exact
from .algorithms.knapsack import knapsack_01, multiple_choice_knapsack
from .algorithms.mst import mst
from .algorithms.placement import GREEDY, Placement, PlacementContext, local_search, packing_feasible
from .algorithms.scheduler import bottleneck_matrix, schedule_batch
from .algorithms.sssp import NegativeCycleError, dijkstra
from .core.graph import Graph
from .model.costs import transfer_cost_graph
from .model.instance import Instance


@dataclass
class SolveConfig:
    strategies: list[str] = field(default_factory=lambda: ["demand_first", "marginal_gain", "regret", "ffd_pack"])
    local_search: bool = True
    exact: str = "auto"                 # "auto" | "always" | "never"
    exact_max_vars: int = 60_000
    exact_time_limit_s: float = 30.0
    vm_budget: float | None = None      # $/h; default: instance.budget or 1.5x min-replica cost
    server_budget: float | None = None  # $/h for server activation; None = all servers on
    sizing: str = "dp"                  # "dp" | "min" | "max"
    apsp_algorithm: str = "auto"
    mst_algorithm: str = "auto"
    heap: str = "binary"
    batch_rule: str = "lpt"
    include_routes: bool = True
    max_route_rows: int = 400
    seed: int = 0

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> "SolveConfig":
        d = d or {}
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**known)


def _ms(t0: float) -> float:
    return round((time.perf_counter() - t0) * 1e3, 3)


def _r(x: float, nd: int = 3) -> float | None:
    return None if x is None or not math.isfinite(x) else round(float(x), nd)


# --------------------------------------------------------------- activation
def activation_values(inst: Instance, D: np.ndarray) -> dict[int, float]:
    """Additive surrogate value of keeping server s on: demand-weighted latency
    saving versus an average server, scaled by its relative capacity."""
    servers = inst.servers
    if not servers:
        return {}
    cap = np.array([inst.cpu(s) for s in servers])
    capscale = np.minimum(1.0, cap / max(np.median(cap), 1e-9))
    vals = np.zeros(len(servers))
    Ds = D[:, servers]
    Ds = np.where(np.isfinite(Ds), Ds, np.nan)
    for sv in inst.services:
        for c, r in sv.demand.items():
            row = Ds[c]
            mean = np.nanmean(row)
            vals += sv.priority * r * np.maximum(0.0, np.nan_to_num(mean - row))
    vals *= capscale
    return {s: float(v) for s, v in zip(servers, vals)}


def select_active_servers(inst: Instance, D: np.ndarray, budget: float) -> dict[str, Any]:
    t0 = time.perf_counter()
    servers = inst.servers
    vals = activation_values(inst, D)
    costs = [inst.server_cost(s) for s in servers]
    res = knapsack_01([vals[s] for s in servers], costs, budget, resolution=0.01)
    chosen = [servers[i] for i in res.chosen]
    # capacity repair: the DP value is a surrogate, so make sure min replicas still fit
    need_cpu = sum(sv.cpu * sv.min_replicas for sv in inst.services)
    need_hosts = max((sv.min_replicas for sv in inst.services), default=1)
    repaired = []
    rest = sorted((s for s in servers if s not in chosen),
                  key=lambda s: -(inst.cpu(s) / max(inst.server_cost(s), 1e-6)))
    while (sum(inst.cpu(s) for s in chosen) < need_cpu * 1.05 or len(chosen) < need_hosts) and rest:
        s = rest.pop(0)
        chosen.append(s)
        repaired.append(s)
    return {
        "budget": budget, "chosen": sorted(chosen), "dp_value": _r(res.value),
        "cost": _r(sum(inst.server_cost(s) for s in chosen), 4),
        "repaired": repaired, "dp_cells": res.table_cells, "runtime_ms": _ms(t0),
        "values": {str(s): _r(v) for s, v in vals.items()},
        "over_budget": sum(inst.server_cost(s) for s in chosen) > budget + 1e-9,
    }


# -------------------------------------------------------------------- sizing
def _single_service_greedy(ctx: PlacementContext, j: int, kmax: int, hosts: list[int]) -> list[float]:
    """Uncapacitated greedy k-median for one service: weighted latency after k = 1..kmax."""
    w = ctx.weights[j]
    if ctx.clients[j].size == 0:
        return [0.0] * kmax
    cols = [ctx.col[s] for s in hosts]
    M = ctx.Dsub[j][:, cols]
    cur = np.full(ctx.clients[j].size, ctx.penalty)
    out = []
    used = set()
    for _ in range(min(kmax, len(cols))):
        g = w @ np.maximum(0.0, cur[:, None] - M)
        g[list(used)] = -1
        b = int(np.argmax(g))
        used.add(b)
        cur = np.minimum(cur, M[:, b])
        out.append(float(w @ cur))
    while len(out) < kmax:
        out.append(out[-1])
    return out


def size_replicas(ctx: PlacementContext, budget: float, mode: str = "dp") -> dict[str, Any]:
    t0 = time.perf_counter()
    inst = ctx.inst
    table, groups, ks = [], [], []
    for j, sv in enumerate(inst.services):
        hosts = [int(s) for s in ctx.servers if ctx.cpu[int(s)] >= sv.cpu and ctx.mem[int(s)] >= sv.mem]
        kmax = max(min(sv.max_replicas, len(hosts)), 0)
        kmin = min(sv.min_replicas, kmax)
        if kmax == 0:
            groups.append([(0.0, 0.0)])
            ks.append([0])
            continue
        lat = _single_service_greedy(ctx, j, kmax, hosts)
        base = lat[kmin - 1] if kmin >= 1 else lat[0]
        opts, kk = [], []
        tw = float(ctx.weights[j].sum()) or 1.0
        for k in range(max(kmin, 1), kmax + 1):
            cost = k * sv.vm_cost
            value = base - lat[k - 1]  # weighted-latency saving vs minimum replicas
            opts.append((value, cost))
            kk.append(k)
            prev = lat[k - 2] if k >= 2 else None
            table.append({
                "service": sv.name, "service_id": j, "replicas": k, "cost_per_hour": _r(cost, 4),
                "avg_latency_ms": _r(lat[k - 1] / tw),
                "saving_vs_min_ms": _r(value / tw),
                "marginal_saving_ms": _r((prev - lat[k - 1]) / tw) if prev is not None else None,
                "marginal_ms_per_dollar": _r(((prev - lat[k - 1]) / tw) / sv.vm_cost)
                if prev is not None and sv.vm_cost > 0 else None,
            })
        groups.append(opts)
        ks.append(kk)
    if mode == "min":
        chosen = [0] * len(groups)
        feasible = True
        cells = 0
    elif mode == "max":
        chosen = [len(g) - 1 for g in groups]
        feasible = True
        cells = 0
    else:
        res = multiple_choice_knapsack(groups, budget, resolution=0.01)
        chosen, feasible, cells = res.chosen, res.feasible, res.table_cells
    targets = [ks[j][c] for j, c in enumerate(chosen)]
    # capacity repair: the DP prices replicas but ignores bin packing, so shrink the
    # extras (largest CPU first) until a first-fit-decreasing packing exists
    trimmed = []
    while not packing_feasible(ctx, targets):
        cand = [j for j in range(len(targets)) if targets[j] > inst.services[j].min_replicas]
        if not cand:
            break
        j = max(cand, key=lambda j: (inst.services[j].cpu, inst.services[j].mem))
        targets[j] -= 1
        trimmed.append(inst.services[j].name)
    packable = packing_feasible(ctx, targets)
    spend = sum(inst.services[j].vm_cost * targets[j] for j in range(len(targets)))
    for row in table:
        row["chosen"] = targets[row["service_id"]] == row["replicas"]
    return {
        "mode": mode, "budget": _r(budget, 4), "targets": targets, "spend": _r(spend, 4),
        "feasible": feasible, "dp_cells": cells, "table": table, "trimmed_for_capacity": trimmed,
        "packable": packable,
        "runtime_ms": _ms(t0),
    }


# ---------------------------------------------------------------- policies
def _tree_dist(g: Graph, edges: list[tuple[int, int, float]], sources: set[int]) -> dict[int, list[float]]:
    t = Graph()
    for a in g.nodes:
        t.add_node(name=a.get("name"))
    for u, v, w in edges:
        t.add_edge(u, v, latency=w)
    return {s: dijkstra(t, s).dist for s in sources}


def route_table(inst: Instance, ctx: PlacementContext, p: Placement, ap: APSPResult,
                tree_edges: list[tuple[int, int, float]], limit: int) -> list[dict[str, Any]]:
    names = [a.get("name", str(i)) for i, a in enumerate(inst.graph.nodes)]
    reps = {s for S in p.replicas.values() for s in S}
    td = _tree_dist(inst.graph, tree_edges, reps)
    rows = []
    for j, sv in enumerate(inst.services):
        S = p.replicas.get(j, [])
        if not S:
            continue
        for c in sorted(sv.demand, key=lambda c: -sv.demand[c]):
            r = min(S, key=lambda s: ctx.D[c, s])
            path = ap.path(c, r)
            lat = float(ctx.D[c, r])
            bb = td[r][c]
            rows.append({
                "service": sv.name, "service_id": j, "client": c, "client_name": names[c],
                "replica": r, "replica_name": names[r], "rate": sv.demand[c],
                "latency_ms": _r(lat), "hops": max(len(path) - 1, 0),
                "path": path, "path_names": [names[x] for x in path],
                "backbone_latency_ms": _r(bb),
                "stretch": _r(bb / lat) if lat > 0 and math.isfinite(bb) else 1.0,
            })
    rows.sort(key=lambda r: (-r["rate"]))
    return rows[:limit]


def server_schedule(inst: Instance, ctx: PlacementContext, p: Placement) -> list[dict[str, Any]]:
    uc, um = ctx.usage(p)
    out = []
    for s in ctx.servers:
        s = int(s)
        vms = [inst.services[j].name for j, S in p.replicas.items() if s in S]
        out.append({
            "server": s, "name": inst.graph.nodes[s].get("name"), "tier": inst.graph.nodes[s].get("tier"),
            "vms": vms, "cpu_used": uc[s], "cpu_cap": ctx.cpu[s], "mem_used": um[s], "mem_cap": ctx.mem[s],
            "cpu_util": _r(uc[s] / ctx.cpu[s]) if ctx.cpu[s] else 0.0,
            "mem_util": _r(um[s] / ctx.mem[s]) if ctx.mem[s] else 0.0,
        })
    out.sort(key=lambda r: -r["cpu_util"])
    return out


def replication_routes(inst: Instance, p: Placement, D: np.ndarray, ap: APSPResult) -> dict[str, Any]:
    """Primary -> secondary replica sync routes: fastest vs cheapest (negative rebates)."""
    t0 = time.perf_counter()
    tg = transfer_cost_graph(inst.graph)
    neg = sum(1 for e in tg.edges() if (e.cost or 0) < 0)
    names = [a.get("name", str(i)) for i, a in enumerate(inst.graph.nodes)]
    try:
        jr = johnson(tg, "cost")
    except NegativeCycleError as exc:
        return {"error": str(exc), "negative_arcs": neg}
    C = jr.dist
    rows = []
    for j, S in p.replicas.items():
        if len(S) < 2:
            continue
        primary = S[0]
        for s in S[1:]:
            fast = ap.path(primary, s)
            fast_cost = sum(tg.edge(a, b).cost for a, b in zip(fast, fast[1:])) if len(fast) > 1 else 0.0
            cheap = jr.path(primary, s)
            cheap_lat = sum(tg.edge(a, b).latency for a, b in zip(cheap, cheap[1:])) if len(cheap) > 1 else 0.0
            rows.append({
                "service": inst.services[j].name, "from": names[primary], "to": names[s],
                "fast_path": [names[x] for x in fast], "fast_latency_ms": _r(D[primary, s]),
                "fast_cost_per_gb": _r(fast_cost, 5),
                "cheap_path": [names[x] for x in cheap], "cheap_latency_ms": _r(cheap_lat),
                "cheap_cost_per_gb": _r(C[primary, s], 5),
                "saving_per_gb": _r(fast_cost - C[primary, s], 5),
            })
    return {"algorithm": jr.algorithm, "negative_arcs": neg, "rows": rows, "runtime_ms": _ms(t0)}


def recommendations(inst: Instance, result: dict[str, Any]) -> list[str]:
    rec = []
    best = result["best"]
    strat = {s["name"]: s for s in result["strategies"]}
    b = strat[best]
    label = "the exact optimal (MILP)" if best == "exact_milp" else f"the '{best}'"
    rec.append(f"Deploy {label} placement: demand-weighted mean latency {b['mean_ms']} ms "
               f"(p95 {b['p95_ms']} ms) at ${b['cost_per_hour']}/h.")
    if "random" in strat:
        rnd = strat["random"]["mean_ms"]
        if rnd and b["mean_ms"] is not None and rnd > 0:
            rec.append(f"That is {round(100 * (1 - b['mean_ms'] / rnd), 1)}% lower latency than a random placement.")
    ex = result.get("exact")
    if ex and ex.get("objective") is not None:
        heur = [s for s in result["strategies"] if s["name"] not in ("exact_milp", "random") and s["feasible"]]
        if heur:
            h = min(heur, key=lambda s: s["mean_ms"])
            rec.append(f"Exact MILP optimum is {ex['objective']} ms (solved in {ex['runtime_ms']} ms); the best "
                       f"heuristic '{h['name']}' is within {h['gap_pct']}% of it in {h['runtime_ms']} ms.")
    # marginal replica advice
    best_marg = None
    for row in result["sizing"]["table"]:
        if row["marginal_ms_per_dollar"] is not None and not row["chosen"]:
            sv_target = result["sizing"]["targets"][row["service_id"]]
            if row["replicas"] == sv_target + 1:
                if best_marg is None or row["marginal_ms_per_dollar"] > best_marg["marginal_ms_per_dollar"]:
                    best_marg = row
    if best_marg:
        rec.append(f"Best next dollar: add a replica of {best_marg['service']} "
                   f"(-{best_marg['marginal_saving_ms']} ms for ${inst.services[best_marg['service_id']].vm_cost}/h).")
    hot = [r for r in result["policy"]["schedule"] if r["cpu_util"] and r["cpu_util"] >= 0.9]
    if hot:
        rec.append(f"{len(hot)} server(s) run at ≥90% CPU ({', '.join(str(h['name']) for h in hot[:4])}); "
                   "capacity there is the binding constraint — upgrading them unlocks better placements.")
    mstinfo = result["topology"]["mst"]
    rec.append(f"Provision the {len(mstinfo['edges'])}-link MST backbone first "
               f"({mstinfo['total_weight']} ms total); it keeps every site connected with the cheapest links.")
    rt = result["policy"].get("routes") or []
    if rt:
        st = [r["stretch"] for r in rt if r["stretch"]]
        if st:
            rec.append(f"Routing over the backbone alone would stretch latency by {round(float(np.mean(st)), 2)}× "
                       "on average; keep the non-tree links for request routing.")
    tr = result["policy"].get("transfer") or {}
    sav = [r["saving_per_gb"] for r in tr.get("rows", []) if r.get("saving_per_gb")]
    if sav and max(sav) > 0:
        rec.append(f"Route replica sync over rebate (negative-cost) peering arcs: saves up to "
                   f"${round(max(sav), 4)}/GB versus the fastest path.")
    return rec


# ---------------------------------------------------------------------- run
def default_vm_budget(inst: Instance) -> float:
    if inst.budget is not None:
        return float(inst.budget)
    return round(1.5 * sum(sv.vm_cost * sv.min_replicas for sv in inst.services), 2)


def solve(inst: Instance, cfg: SolveConfig | None = None) -> dict[str, Any]:
    cfg = cfg or SolveConfig()
    T0 = time.perf_counter()
    out: dict[str, Any] = {"instance": inst.summary(), "warnings": inst.validate(), "config": cfg.__dict__}
    g = inst.graph

    # 1 topology
    t0 = time.perf_counter()
    ap = apsp(g, "latency", cfg.apsp_algorithm, cfg.heap)
    apsp_ms = _ms(t0)
    t0 = time.perf_counter()
    tree = mst(g, cfg.mst_algorithm, "latency") if not g.directed else mst(g.to_undirected(), cfg.mst_algorithm)
    out["topology"] = {
        "apsp": {"algorithm": ap.algorithm, "runtime_ms": apsp_ms, "density": ap.meta.get("density")},
        "mst": {**{k: v for k, v in tree.to_dict().items() if k != "trace"},
                "total_weight": _r(tree.total_weight), "runtime_ms": _ms(t0)},
        "diameter_ms": _r(float(np.max(ap.dist[np.isfinite(ap.dist)]))) if g.n else 0.0,
    }
    D = ap.dist

    # 2 activation
    active = None
    if cfg.server_budget is not None:
        act = select_active_servers(inst, D, cfg.server_budget)
        active = act["chosen"]
        out["activation"] = act
    ctx = PlacementContext(inst, D, active)

    # 3 sizing
    vm_budget = cfg.vm_budget if cfg.vm_budget is not None else default_vm_budget(inst)
    sizing = size_replicas(ctx, vm_budget, cfg.sizing)
    targets = sizing["targets"]
    out["sizing"] = sizing

    # 4-5 placement
    placements: list[Placement] = []
    names = list(dict.fromkeys(["random"] + cfg.strategies))
    for name in names:
        fn = GREEDY[name]
        p = fn(ctx, targets, seed=cfg.seed) if name == "random" else fn(ctx, targets)
        placements.append(p)
        if cfg.local_search and name != "random":
            placements.append(local_search(ctx, p))

    # 6 exact
    exact = None
    n_vars = len(ctx.servers) * ctx.J + sum(c.size for c in ctx.clients) * len(ctx.servers)
    run_exact = cfg.exact == "always" or (cfg.exact == "auto" and n_vars <= cfg.exact_max_vars)
    if run_exact:
        ex = solve_exact(ctx, targets, time_limit_s=cfg.exact_time_limit_s)
        if ex.feasible and not ctx.check(ex, targets):
            placements.append(ex)
            exact = {"objective": _r(ctx.objective(ex)), "runtime_ms": _r(ex.runtime_ms),
                     "optimal": ex.stats.get("optimal"), "status": ex.stats.get("status"),
                     "dual_bound": _r(ex.stats.get("dual_bound")), "variables": ex.stats.get("variables"),
                     "constraints": ex.stats.get("constraints")}
        else:
            exact = {"objective": None, "status": "; ".join(ex.notes) or "infeasible"}
    else:
        exact = {"objective": None, "status": f"skipped ({n_vars} variables > limit {cfg.exact_max_vars})"}
    out["exact"] = exact

    rows = []
    for p in placements:
        errs = ctx.check(p, targets)
        st = ctx.latency_stats(p)
        cost = sum(inst.services[j].vm_cost * len(S) for j, S in p.replicas.items())
        rows.append({
            "name": p.strategy, "feasible": p.feasible and not errs, "violations": errs[:5],
            "mean_ms": _r(st["mean"]), "p50_ms": _r(st["p50"]), "p95_ms": _r(st["p95"]), "max_ms": _r(st["max"]),
            "runtime_ms": _r(p.runtime_ms), "cost_per_hour": _r(cost, 4),
            "replicas": {str(j): S for j, S in p.replicas.items()},
            "notes": p.notes, "stats": {k: (_r(v) if isinstance(v, float) else v) for k, v in p.stats.items()},
        })
    opt = exact.get("objective") if exact else None
    for r in rows:
        r["gap_pct"] = _r(100 * (r["mean_ms"] - opt) / opt, 2) if opt and r["mean_ms"] is not None else None
    feas = [r for r in rows if r["feasible"]]
    best_row = min(feas or rows, key=lambda r: (r["mean_ms"] if r["mean_ms"] is not None else math.inf))
    out["strategies"] = rows
    out["best"] = best_row["name"]
    best_p = next(p for p in placements if p.strategy == best_row["name"])

    # 7 policies
    policy: dict[str, Any] = {"schedule": server_schedule(inst, ctx, best_p)}
    if cfg.include_routes:
        policy["routes"] = route_table(inst, ctx, best_p, ap, tree.edges, cfg.max_route_rows)
        policy["transfer"] = replication_routes(inst, best_p, D, ap)
    if inst.tasks:
        srcs = sorted({t.data_node for t in inst.tasks})
        B = bottleneck_matrix(inst, ap, srcs)
        policy["batch"] = schedule_batch(inst, D, B, cfg.batch_rule,
                                         [int(s) for s in ctx.servers]).to_dict()
    out["policy"] = policy
    out["recommendations"] = recommendations(inst, out)
    out["total_runtime_ms"] = _ms(T0)
    return out
