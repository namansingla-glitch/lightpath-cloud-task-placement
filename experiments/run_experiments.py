"""Experiment suite: runtime + solution quality vs size, density, capacity, budget.

    python experiments/run_experiments.py            # full run (~2-4 min)
    python experiments/run_experiments.py --quick    # smoke run

Writes experiments/results/*.csv, results/summary.json (used by the dashboard)
and experiments/figures/*.png (used by the report).
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402

from cloudplace.algorithms import (GREEDY, PlacementContext, apsp, dijkstra, floyd_warshall,  # noqa: E402
                                   floyd_warshall_numpy, johnson, knapsack_01, kruskal, local_search, prim,
                                   repeated_dijkstra, solve_exact, bellman_ford)
from cloudplace.data.export import rows_to_csv  # noqa: E402
from cloudplace.data.generators import build_instance, erdos_renyi, waxman  # noqa: E402
from cloudplace.model import transfer_cost_graph  # noqa: E402
from cloudplace.solver import SolveConfig, size_replicas, solve  # noqa: E402

RES = ROOT / "experiments" / "results"
FIG = ROOT / "experiments" / "figures"


def timeit(fn, repeat: int = 3) -> float:
    ts = []
    for _ in range(repeat):
        t0 = time.perf_counter()
        fn()
        ts.append((time.perf_counter() - t0) * 1e3)
    return round(statistics.median(ts), 3)


# ------------------------------------------------------------------ E1 heaps
def exp_sssp_heaps(sizes):
    rows = []
    for n in sizes:
        g = waxman(n, alpha=0.5, beta=0.08, seed=n)
        for heap in ["binary", "fibonacci", "pairing", "lazy"]:
            rows.append({"n": n, "m": g.m, "heap": heap,
                         "dijkstra_ms": timeit(lambda: dijkstra(g, 0, heap=heap)),
                         "prim_ms": timeit(lambda: prim(g, heap=heap))})
        gd = transfer_cost_graph(g)
        rows[-1]["bellman_ford_ms"] = timeit(lambda: bellman_ford(gd, 0, "cost"), 1)
        print(f"  E1 n={n}")
    return rows


# ------------------------------------------------------------------ E2 APSP
def exp_apsp(sizes, pure_limit):
    rows = []
    for n in sizes:
        for label, p in [("sparse", min(1.0, 3.0 / n)), ("dense", 0.5)]:
            g = erdos_renyi(n, p, seed=n)
            algs = {"floyd_warshall_numpy": lambda: floyd_warshall_numpy(g),
                    "johnson": lambda: johnson(g, "latency"),
                    "repeated_dijkstra": lambda: repeated_dijkstra(g)}
            if n <= pure_limit:
                algs["floyd_warshall"] = lambda: floyd_warshall(g)
            for name, fn in algs.items():
                rows.append({"n": n, "density": label, "m": g.m, "algorithm": name,
                             "ms": timeit(fn, 1 if n >= 200 else 3)})
            rows.append({"n": n, "density": label, "m": g.m, "algorithm": "auto_choice",
                         "ms": None, "choice": apsp(g).algorithm})
        print(f"  E2 n={n}")
    return rows


# ------------------------------------------------------------------- E3 MST
def exp_mst_density(n, ps):
    rows = []
    for p in ps:
        g = erdos_renyi(n, p, seed=int(p * 1000))
        rows.append({"n": n, "p": p, "m": g.m,
                     "prim_binary_ms": timeit(lambda: prim(g, heap="binary")),
                     "prim_fibonacci_ms": timeit(lambda: prim(g, heap="fibonacci")),
                     "prim_lazy_ms": timeit(lambda: prim(g, heap="lazy")),
                     "kruskal_ms": timeit(lambda: kruskal(g)),
                     "weight": round(kruskal(g).total_weight, 3)})
        print(f"  E3 p={p}")
    return rows


# ------------------------------------------------- placement quality helper
def run_strategies(inst, exact_limit_vars=60_000, time_limit=30.0, ls=True):
    ap = apsp(inst.graph)
    ctx = PlacementContext(inst, ap.dist)
    budget = inst.budget
    targets = size_replicas(ctx, budget)["targets"]
    out = {}
    for name, fn in GREEDY.items():
        p = fn(ctx, targets)
        out[name] = (p, ctx.objective(p) if p.feasible else None)
        if ls and name != "random" and p.feasible:
            q = local_search(ctx, p)
            out[name + "+ls"] = (q, ctx.objective(q))
    nv = len(ctx.servers) * ctx.J + sum(c.size for c in ctx.clients) * len(ctx.servers)
    ref, ref_kind = None, None
    if nv <= exact_limit_vars:
        ex = solve_exact(ctx, targets, time_limit_s=time_limit)
        if ex.feasible and not ctx.check(ex, targets):
            out["exact_milp"] = (ex, ctx.objective(ex))
            ref, ref_kind = ctx.objective(ex), "milp" if ex.stats.get("optimal") else "milp_timelimit"
    if ref is None:
        lp = solve_exact(ctx, targets, relax=True, time_limit_s=time_limit)
        if lp.stats.get("objective") is not None:
            ref, ref_kind = lp.stats["objective"], "lp_bound"
    return out, ref, ref_kind, nv


# ------------------------------------------------------- E4 quality vs size
def exp_quality_size(sizes, seeds):
    rows = []
    for n in sizes:
        for seed in seeds:
            inst = build_instance("waxman", n=n, seed=seed, services=max(6, n // 5), tasks=0)
            out, ref, kind, nv = run_strategies(inst)
            for name, (p, obj) in out.items():
                rows.append({"n": n, "seed": seed, "strategy": name, "feasible": p.feasible,
                             "mean_ms": None if obj is None else round(obj, 4),
                             "runtime_ms": round(p.runtime_ms, 3), "reference": kind,
                             "gap_pct": None if (obj is None or not ref) else round(100 * (obj - ref) / ref, 3),
                             "milp_vars": nv})
        print(f"  E4 n={n}")
    return rows


# ------------------------------------------------------ E5 capacity tightness
def exp_capacity(n, factors, seeds):
    rows = []
    for cf in factors:
        for seed in seeds:
            inst = build_instance("waxman", n=n, seed=seed, services=12, tasks=0, capacity_factor=cf)
            out, ref, kind, _ = run_strategies(inst)
            cpu = sum(inst.cpu(s) for s in inst.servers)
            load = sum(s.cpu * s.min_replicas for s in inst.services) / cpu if cpu else None
            for name, (p, obj) in out.items():
                rows.append({"capacity_factor": cf, "seed": seed, "load": round(load, 3) if load else None,
                             "strategy": name, "feasible": p.feasible,
                             "mean_ms": None if obj is None else round(obj, 4), "reference": kind,
                             "gap_pct": None if (obj is None or not ref) else round(100 * (obj - ref) / ref, 3),
                             "runtime_ms": round(p.runtime_ms, 3)})
        print(f"  E5 cf={cf}")
    return rows


# ------------------------------------------------------------ E6 density
def exp_density(n, ps, seeds):
    rows = []
    for p in ps:
        for seed in seeds:
            inst = build_instance("erdos_renyi", n=n, seed=seed, services=10, tasks=0, p=p)
            t0 = time.perf_counter()
            ap = apsp(inst.graph)
            apsp_ms = (time.perf_counter() - t0) * 1e3
            out, ref, kind, _ = run_strategies(inst)
            for name, (pl, obj) in out.items():
                rows.append({"p": p, "seed": seed, "m": inst.graph.m, "apsp": ap.algorithm,
                             "apsp_ms": round(apsp_ms, 3), "strategy": name,
                             "mean_ms": None if obj is None else round(obj, 4),
                             "gap_pct": None if (obj is None or not ref) else round(100 * (obj - ref) / ref, 3),
                             "runtime_ms": round(pl.runtime_ms, 3)})
        print(f"  E6 p={p}")
    return rows


# ------------------------------------------------------- E7 budget frontier
def exp_budget(model, budgets):
    rows = []
    inst = build_instance(model, seed=7, services=8, tasks=0)
    for b in budgets:
        for sizing in ["dp", "min"]:
            r = solve(inst, SolveConfig(vm_budget=b, sizing=sizing, include_routes=False,
                                        strategies=["marginal_gain"], exact="auto"))
            best = next(s for s in r["strategies"] if s["name"] == r["best"])
            rows.append({"budget": b, "sizing": sizing, "spend": r["sizing"]["spend"],
                         "mean_ms": best["mean_ms"], "p95_ms": best["p95_ms"], "best": r["best"],
                         "replicas": sum(r["sizing"]["targets"])})
        print(f"  E7 budget={b}")
    return rows


# ------------------------------------------------------------- E8 knapsack
def exp_knapsack(ns, Ws):
    rng = np.random.default_rng(0)
    rows = []
    for n in ns:
        for W in Ws:
            v = rng.uniform(1, 100, n).tolist()
            w = rng.integers(1, max(2, W // 4), n).tolist()
            rows.append({"n": n, "W": W, "cells": n * (W + 1), "ms": timeit(lambda: knapsack_01(v, w, W), 1)})
    print("  E8 done")
    return rows


# ---------------------------------------------------------------- figures
def figures(R):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    FIG.mkdir(parents=True, exist_ok=True)
    C = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False,
                         "axes.spines.right": False, "axes.grid": True, "grid.color": "#e6e5e0",
                         "grid.linewidth": 0.8, "axes.edgecolor": "#8a8984", "axes.labelcolor": "#52514e",
                         "xtick.color": "#52514e", "ytick.color": "#52514e", "legend.frameon": False,
                         "figure.dpi": 150, "lines.linewidth": 2, "lines.markersize": 5})

    def save(fig, name):
        fig.tight_layout()
        fig.savefig(FIG / f"{name}.png", bbox_inches="tight")
        plt.close(fig)

    # E1
    rows = R["sssp_heaps"]
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.8))
    for ax, key, title in [(axes[0], "dijkstra_ms", "Dijkstra"), (axes[1], "prim_ms", "Prim")]:
        for i, h in enumerate(["binary", "fibonacci", "pairing", "lazy"]):
            pts = [(r["n"], r[key]) for r in rows if r["heap"] == h]
            ax.plot(*zip(*pts), marker="o", color=C[i], label=h)
        ax.set(xscale="log", yscale="log", xlabel="vertices n (Waxman, sparse)", ylabel="runtime (ms)",
               title=f"{title}: priority-queue comparison")
    axes[0].legend()
    save(fig, "e1_heaps")

    # E2
    rows = [r for r in R["apsp"] if r["ms"] is not None]
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.8), sharey=True)
    for ax, dens in zip(axes, ["sparse", "dense"]):
        for i, a in enumerate(["floyd_warshall", "floyd_warshall_numpy", "johnson", "repeated_dijkstra"]):
            pts = [(r["n"], r["ms"]) for r in rows if r["density"] == dens and r["algorithm"] == a]
            if pts:
                ax.plot(*zip(*pts), marker="o", color=C[i], label=a.replace("_", " "))
        ax.set(xscale="log", yscale="log", xlabel="vertices n", title=f"APSP on {dens} graphs")
    axes[0].set_ylabel("runtime (ms)")
    axes[0].legend()
    save(fig, "e2_apsp")

    # E3
    rows = R["mst_density"]
    fig, ax = plt.subplots(figsize=(6, 3.8))
    for i, (k, lab) in enumerate([("prim_binary_ms", "Prim (binary)"), ("prim_fibonacci_ms", "Prim (Fibonacci)"),
                                  ("prim_lazy_ms", "Prim (lazy heapq)"), ("kruskal_ms", "Kruskal")]):
        ax.plot([r["m"] for r in rows], [r[k] for r in rows], marker="o", color=C[i], label=lab)
    ax.set(xlabel=f"edges m (n={rows[0]['n']})", ylabel="runtime (ms)", title="MST runtime vs density")
    ax.legend()
    save(fig, "e3_mst")

    strat_order = ["demand_first", "marginal_gain", "regret", "ffd_pack"]

    # E4 gap + runtime
    rows = R["quality_size"]
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.8))
    sizes = sorted({r["n"] for r in rows})
    for i, s in enumerate(strat_order):
        for suffix, ls_ in [("", "--"), ("+ls", "-")]:
            nm = s + suffix
            g = [statistics.mean([r["gap_pct"] for r in rows if r["n"] == n and r["strategy"] == nm
                                  and r["gap_pct"] is not None] or [np.nan]) for n in sizes]
            axes[0].plot(sizes, g, ls_, marker="o", color=C[i], label=nm)
    axes[0].set(xlabel="vertices n", ylabel="gap to optimum / LP bound (%)", title="Solution quality vs size")
    axes[0].legend(fontsize=8, ncol=2)
    for i, s in enumerate(strat_order + ["exact_milp"]):
        for nm, ls_ in ([(s, "--"), (s + "+ls", "-")] if s != "exact_milp" else [(s, "-")]):
            t = [statistics.mean([r["runtime_ms"] for r in rows if r["n"] == n and r["strategy"] == nm] or [np.nan])
                 for n in sizes]
            axes[1].plot(sizes, t, ls_, marker="o", color=C[i], label=nm if ls_ == "-" else None)
    axes[1].set(xlabel="vertices n", ylabel="runtime (ms)", yscale="log", title="Solver runtime vs size")
    axes[1].legend(fontsize=8)
    save(fig, "e4_quality_size")

    # E5
    rows = R["capacity"]
    fs = sorted({r["capacity_factor"] for r in rows})
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.8))
    for i, s in enumerate(strat_order):
        nm = s + "+ls"
        feas = [100 * statistics.mean([1.0 if r["feasible"] else 0.0 for r in rows
                                       if r["capacity_factor"] == f and r["strategy"] == s]) for f in fs]
        gap = [statistics.mean([r["gap_pct"] for r in rows if r["capacity_factor"] == f and r["strategy"] == nm
                                and r["gap_pct"] is not None] or [np.nan]) for f in fs]
        axes[0].plot(fs, feas, marker="o", color=C[i], label=s)
        axes[1].plot(fs, gap, marker="o", color=C[i], label=nm)
    axes[0].set(xlabel="capacity factor (× nominal)", ylabel="feasible runs (%)", title="Feasibility vs capacity")
    axes[1].set(xlabel="capacity factor (× nominal)", ylabel="gap (%)", title="Gap after local search vs capacity")
    axes[0].legend()
    axes[1].legend()
    save(fig, "e5_capacity")

    # E6
    rows = R["density"]
    ps = sorted({r["p"] for r in rows})
    fig, axes = plt.subplots(1, 2, figsize=(10, 3.8))
    for i, s in enumerate(["random", "demand_first+ls", "marginal_gain+ls", "regret+ls", "ffd_pack+ls", "exact_milp"]):
        y = [statistics.mean([r["mean_ms"] for r in rows if r["p"] == p and r["strategy"] == s
                              and r["mean_ms"] is not None] or [np.nan]) for p in ps]
        axes[0].plot(ps, y, marker="o", color=C[(i - 1) % 8] if s != "random" else "#8a8984", label=s)
    axes[0].set(xscale="log", xlabel="edge probability p (n=80)", ylabel="mean latency (ms)",
                title="Latency vs network density")
    axes[0].legend(fontsize=8)
    ap = [statistics.mean([r["apsp_ms"] for r in rows if r["p"] == p and r["strategy"] == "random"]) for p in ps]
    axes[1].plot(ps, ap, marker="o", color=C[0])
    for p, a in zip(ps, ap):
        ch = next(r["apsp"] for r in rows if r["p"] == p)
        axes[1].annotate("FW" if "floyd" in ch else "Dijkstra×n", (p, a), textcoords="offset points",
                         xytext=(0, 7), ha="center", fontsize=8, color="#52514e")
    axes[1].set(xscale="log", xlabel="edge probability p", ylabel="APSP runtime (ms)",
                title="Auto-selected APSP algorithm")
    save(fig, "e6_density")

    # E7
    rows = R["budget"]
    fig, ax = plt.subplots(figsize=(6, 3.8))
    for i, sz in enumerate(["dp", "min"]):
        pts = sorted((r["spend"], r["mean_ms"]) for r in rows if r["sizing"] == sz)
        ax.plot(*zip(*pts), marker="o", color=C[i], label="MCKP DP sizing" if sz == "dp" else "min replicas")
    ax.set(xlabel="VM spend ($/h)", ylabel="mean latency (ms)", title="Cost / latency frontier (India)")
    ax.legend()
    save(fig, "e7_budget")

    # E8
    rows = R["knapsack"]
    fig, ax = plt.subplots(figsize=(6, 3.8))
    ax.plot([r["cells"] for r in rows], [r["ms"] for r in rows], "o", color=C[0])
    ax.set(xscale="log", yscale="log", xlabel="DP table cells n·(W+1)", ylabel="runtime (ms)",
           title="0/1 knapsack DP is Θ(nW)")
    save(fig, "e8_knapsack")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    a = ap.parse_args()
    RES.mkdir(parents=True, exist_ok=True)
    q = a.quick
    R = {}
    t0 = time.perf_counter()
    print("E1 heaps");    R["sssp_heaps"] = exp_sssp_heaps([100, 300] if q else [100, 250, 500, 1000, 2000, 4000])
    print("E2 apsp");     R["apsp"] = exp_apsp([25, 50] if q else [25, 50, 100, 200, 400], 100 if q else 200)
    print("E3 mst");      R["mst_density"] = exp_mst_density(200 if q else 600, [0.01, 0.1] if q else [0.005, 0.01, 0.03, 0.1, 0.3, 0.6])
    seeds = [0] if q else [0, 1, 2]
    print("E4 quality");  R["quality_size"] = exp_quality_size([20, 40] if q else [20, 40, 60, 80, 120, 160, 240], seeds)
    print("E5 capacity"); R["capacity"] = exp_capacity(50, [0.3, 1.0] if q else [0.25, 0.3, 0.35, 0.45, 0.6, 0.8, 1.0, 1.5], seeds)
    print("E6 density");  R["density"] = exp_density(80, [0.03, 0.2] if q else [0.025, 0.05, 0.1, 0.2, 0.4, 0.7], seeds)
    print("E7 budget");   R["budget"] = exp_budget("india", [1, 2] if q else [2.0, 2.5, 3.0, 3.5, 4, 5, 6, 8, 10, 14])
    print("E8 knapsack"); R["knapsack"] = exp_knapsack([10, 50] if q else [10, 50, 100, 200], [100, 1000] if q else [100, 500, 1000, 5000])
    for k, rows in R.items():
        rows_to_csv(rows, RES / f"{k}.csv")
    (RES / "summary.json").write_text(json.dumps({"generated": time.strftime("%Y-%m-%d %H:%M"),
                                                  "quick": q, "results": R}, indent=0))
    figures(R)
    print(f"done in {time.perf_counter() - t0:.1f}s")


if __name__ == "__main__":
    main()
