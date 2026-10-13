"""Exact placement by mixed-integer programming (HiGHS via scipy.optimize.milp).

Variables
    y[s,j] ∈ {0,1}   replica of service j on server s
    x[c,s,j] ∈ [0,1] fraction of client c of service j served by s
                     (integral at an optimum: each client goes to its nearest open replica)
min  Σ w_cj · d(c,s) · x[c,s,j]
s.t. Σ_s x[c,s,j] = 1                    every client served
     x[c,s,j] ≤ y[s,j]                   only by open replicas (disaggregated → tight LP)
     Σ_s y[s,j] = k_j                    (fixed targets)   — or —
     kmin_j ≤ Σ_s y[s,j] ≤ kmax_j,  Σ_j p_j Σ_s y[s,j] ≤ B   (joint sizing + budget)
     Σ_j cpu_j y[s,j] ≤ C_s,  Σ_j mem_j y[s,j] ≤ M_s

Size: |S|·J binaries and Σ_j |C_j|·|S| continuous variables — exact solving is
practical up to a few dozen servers; beyond that we report the LP relaxation
lower bound to bound the heuristics' gap.
"""
from __future__ import annotations

import time
from typing import Sequence

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import coo_matrix

from .placement import Placement, PlacementContext


def solve_exact(ctx: PlacementContext, targets: Sequence[int] | None = None, budget: float | None = None,
                time_limit_s: float = 60.0, relax: bool = False) -> Placement:
    t0 = time.perf_counter()
    S = [int(s) for s in ctx.servers]
    nS, J = len(S), ctx.J
    svc = ctx.inst.services
    # variable layout
    y_idx = lambda s_i, j: s_i * J + j  # noqa: E731
    nY = nS * J
    # services forced to 0 replicas (nothing can host them) keep the penalty latency,
    # exactly as the heuristics' objective does; they get no assignment variables
    zero = [targets is not None and targets[j] == 0 for j in range(J)]
    nclients = [0 if zero[j] else ctx.clients[j].size for j in range(J)]
    const = sum(float(ctx.weights[j].sum()) * ctx.penalty for j in range(J) if zero[j]) / ctx.total_weight
    x_off = []
    off = nY
    for j in range(J):
        x_off.append(off)
        off += nclients[j] * nS
    nV = off
    c = np.zeros(nV)
    for j in range(J):
        nc = nclients[j]
        if nc:
            c[x_off[j]:x_off[j] + nc * nS] = (ctx.weights[j][:, None] * ctx.Dsub[j]).ravel()
    c /= ctx.total_weight

    rows, cols, vals, lo, hi = [], [], [], [], []
    r = 0

    def add(coefs: list[tuple[int, float]], lb: float, ub: float) -> None:
        nonlocal r
        for col, v in coefs:
            rows.append(r); cols.append(col); vals.append(v)
        lo.append(lb); hi.append(ub)
        r += 1

    for j in range(J):
        nc = nclients[j]
        for ci in range(nc):
            add([(x_off[j] + ci * nS + si, 1.0) for si in range(nS)], 1.0, 1.0)
            for si in range(nS):
                add([(x_off[j] + ci * nS + si, 1.0), (y_idx(si, j), -1.0)], -np.inf, 0.0)
        ys = [(y_idx(si, j), 1.0) for si in range(nS)]
        if targets is not None:
            add(ys, targets[j], targets[j])
        else:
            add(ys, svc[j].min_replicas, svc[j].max_replicas)
    if targets is None and budget is not None:
        add([(y_idx(si, j), svc[j].vm_cost) for j in range(J) for si in range(nS)], -np.inf, budget)
    for si, s in enumerate(S):
        add([(y_idx(si, j), svc[j].cpu) for j in range(J)], -np.inf, ctx.cpu[s])
        add([(y_idx(si, j), svc[j].mem) for j in range(J)], -np.inf, ctx.mem[s])

    A = coo_matrix((vals, (rows, cols)), shape=(r, nV)).tocsr()
    integrality = np.zeros(nV)
    if not relax:
        integrality[:nY] = 1
    res = milp(c, constraints=LinearConstraint(A, lo, hi), integrality=integrality,
               bounds=Bounds(0, 1), options={"time_limit": time_limit_s, "disp": False})
    rt = (time.perf_counter() - t0) * 1e3
    name = "lp_bound" if relax else "exact_milp"
    if res.x is None:
        return Placement({j: [] for j in range(J)}, name, False, rt,
                         [f"solver status {res.status}: {res.message}"])
    reps = {j: [S[si] for si in range(nS) if res.x[y_idx(si, j)] > 0.5] for j in range(J)}
    p = Placement(reps, name, not relax, rt)
    p.stats["objective"] = float(res.fun) + const
    p.stats["optimal"] = bool(res.status == 0)
    p.stats["status"] = res.message
    p.stats["mip_gap"] = float(getattr(res, "mip_gap", 0.0) or 0.0)
    p.stats["dual_bound"] = float(getattr(res, "mip_dual_bound", res.fun) or res.fun) + const
    p.stats["variables"] = nV
    p.stats["constraints"] = r
    return p
