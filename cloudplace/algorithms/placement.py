"""Replica placement: evaluation, greedy schedulers and local search.

Given the all-pairs latency matrix D, replica targets k_j and the set of active
servers, choose replica locations minimising demand-weighted latency subject to
CPU / memory capacity and anti-affinity (≤ 1 replica of a service per server).

Greedy schedulers
-----------------
* ``random``        — random feasible placement (sanity baseline).
* ``demand_first``  — for each service (largest demand first) walk its client
                      hotspots by rate and put a replica on the nearest server
                      that still has room.  O(J · C log C + Σk · S).
* ``marginal_gain`` — CELF lazy greedy on the facility-location *savings*
                      function F_j(S) = Σ_c w_c (P − min_{s∈S} d(c,s)).  F_j is
                      monotone submodular, so without capacity limits greedy is
                      a (1 − 1/e)-approximation of the best savings for each
                      cardinality (Nemhauser–Wolsey–Fisher 1978).  Lazy
                      re-evaluation is valid because marginal gains never
                      increase as replicas are added (submodularity).
* ``regret``        — at every step pick the service whose best and second
                      best feasible server differ the most (max regret), the
                      classic GAP heuristic (Martello–Toth) that protects
                      services with few good options from being crowded out.

Local search
------------
``local_search`` repeatedly applies the best improving *move* (relocate one
replica) or *swap* (exchange replicas of two services between two servers so
both fit) until no move improves the objective by more than eps.  Each
accepted move strictly decreases the objective and the number of placements
is finite, so it terminates in a local optimum; for uncapacitated k-median,
single-swap local optima are within a factor 5 of optimal (Arya et al. 2004).
"""
from __future__ import annotations

import heapq
import math
import random
import time
from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np

from ..model.instance import Instance


@dataclass
class Placement:
    replicas: dict[int, list[int]]                  # service index -> server nodes
    strategy: str = ""
    feasible: bool = True
    runtime_ms: float = 0.0
    notes: list[str] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)

    def copy(self) -> "Placement":
        return Placement({j: list(v) for j, v in self.replicas.items()}, self.strategy,
                         self.feasible, self.runtime_ms, list(self.notes), dict(self.stats))


class PlacementContext:
    """Pre-computes per-service client arrays so evaluations are vectorised."""

    def __init__(self, inst: Instance, D: np.ndarray, active: Sequence[int] | None = None) -> None:
        self.inst = inst
        self.D = D
        self.servers = np.array(sorted(active if active is not None else inst.servers), dtype=int)
        self.cpu = {int(s): inst.cpu(s) for s in self.servers}
        self.mem = {int(s): inst.mem(s) for s in self.servers}
        finite = D[np.isfinite(D)]
        self.penalty = float(finite.max() * 2 + 1) if finite.size else 1.0
        self.clients: list[np.ndarray] = []
        self.weights: list[np.ndarray] = []
        for sv in inst.services:
            cs = np.array(sorted(sv.demand), dtype=int)
            self.clients.append(cs)
            self.weights.append(np.array([sv.demand[c] * sv.priority for c in cs], dtype=float))
        self.total_weight = float(sum(w.sum() for w in self.weights)) or 1.0
        # D restricted to (clients x active servers) per service
        self.Dsub = [np.minimum(D[np.ix_(cs, self.servers)], self.penalty) if cs.size else
                     np.zeros((0, len(self.servers))) for cs in self.clients]
        self.col = {int(s): i for i, s in enumerate(self.servers)}

    @property
    def J(self) -> int:
        return len(self.inst.services)

    def fits(self, j: int, s: int, used_cpu: dict[int, float], used_mem: dict[int, float]) -> bool:
        sv = self.inst.services[j]
        return (used_cpu[s] + sv.cpu <= self.cpu[s] + 1e-9) and (used_mem[s] + sv.mem <= self.mem[s] + 1e-9)

    def service_cost(self, j: int, S: Sequence[int]) -> float:
        if self.clients[j].size == 0:
            return 0.0
        if not S:
            return float(self.weights[j].sum() * self.penalty)
        cols = [self.col[s] for s in S]
        return float(self.weights[j] @ self.Dsub[j][:, cols].min(axis=1))

    def objective(self, p: Placement) -> float:
        return sum(self.service_cost(j, p.replicas.get(j, [])) for j in range(self.J)) / self.total_weight

    def usage(self, p: Placement) -> tuple[dict[int, float], dict[int, float]]:
        uc = {int(s): 0.0 for s in self.servers}
        um = {int(s): 0.0 for s in self.servers}
        for j, S in p.replicas.items():
            sv = self.inst.services[j]
            for s in S:
                uc[s] = uc.get(s, 0.0) + sv.cpu
                um[s] = um.get(s, 0.0) + sv.mem
        return uc, um

    def check(self, p: Placement, targets: Sequence[int] | None = None) -> list[str]:
        errs = []
        uc, um = self.usage(p)
        for s in uc:
            if s not in self.cpu:
                errs.append(f"server {s} is not active")
                continue
            if uc[s] > self.cpu[s] + 1e-9:
                errs.append(f"server {s} cpu {uc[s]} > {self.cpu[s]}")
            if um[s] > self.mem[s] + 1e-9:
                errs.append(f"server {s} mem {um[s]} > {self.mem[s]}")
        for j in range(self.J):
            S = p.replicas.get(j, [])
            if len(set(S)) != len(S):
                errs.append(f"service {j} has two replicas on one server")
            if targets is not None and len(S) != targets[j]:
                errs.append(f"service {j} has {len(S)} replicas, wanted {targets[j]}")
        return errs

    def latency_stats(self, p: Placement) -> dict[str, float]:
        lat, wts = [], []
        for j in range(self.J):
            S = p.replicas.get(j, [])
            if self.clients[j].size == 0:
                continue
            if S:
                d = self.Dsub[j][:, [self.col[s] for s in S]].min(axis=1)
            else:
                d = np.full(self.clients[j].size, self.penalty)
            lat.append(d)
            wts.append(self.weights[j])
        if not lat:
            return {"mean": 0.0, "p50": 0.0, "p95": 0.0, "max": 0.0}
        L = np.concatenate(lat)
        W = np.concatenate(wts)
        order = np.argsort(L)
        cw = np.cumsum(W[order]) / W.sum()

        def q(x: float) -> float:
            return float(L[order][np.searchsorted(cw, x)])

        return {"mean": float(L @ W / W.sum()), "p50": q(0.5), "p95": q(0.95), "max": float(L.max())}


# ------------------------------------------------------------------ greedies
def _empty(ctx: PlacementContext) -> tuple[dict[int, list[int]], dict[int, float], dict[int, float]]:
    return ({j: [] for j in range(ctx.J)}, {int(s): 0.0 for s in ctx.servers},
            {int(s): 0.0 for s in ctx.servers})


def _finish(ctx: PlacementContext, reps: dict[int, list[int]], targets: Sequence[int], name: str,
            t0: float, notes: list[str] | None = None) -> Placement:
    feasible = all(len(reps[j]) == targets[j] for j in range(ctx.J))
    notes = notes or []
    if not feasible:
        short = [ctx.inst.services[j].name for j in range(ctx.J) if len(reps[j]) < targets[j]]
        notes.append(f"capacity exhausted before placing all replicas of: {', '.join(short)}")
    return Placement(reps, name, feasible, (time.perf_counter() - t0) * 1e3, notes)


def greedy_random(ctx: PlacementContext, targets: Sequence[int], seed: int = 0) -> Placement:
    t0 = time.perf_counter()
    rng = random.Random(seed)
    reps, uc, um = _empty(ctx)
    order = [j for j in range(ctx.J) for _ in range(targets[j])]
    rng.shuffle(order)
    for j in order:
        cands = [int(s) for s in ctx.servers if int(s) not in reps[j] and ctx.fits(j, int(s), uc, um)]
        if not cands:
            continue
        s = rng.choice(cands)
        reps[j].append(s)
        uc[s] += ctx.inst.services[j].cpu
        um[s] += ctx.inst.services[j].mem
    return _finish(ctx, reps, targets, "random", t0)


def greedy_demand_first(ctx: PlacementContext, targets: Sequence[int]) -> Placement:
    t0 = time.perf_counter()
    reps, uc, um = _empty(ctx)
    order = sorted(range(ctx.J), key=lambda j: -ctx.weights[j].sum())
    D = ctx.D
    for j in order:
        sv = ctx.inst.services[j]
        hotspots = sorted(sv.demand, key=lambda c: -sv.demand[c])
        servers_by_dist = {}
        h = 0
        while len(reps[j]) < targets[j]:
            if h < len(hotspots):
                c = hotspots[h]
                h += 1
            else:  # more replicas than hotspots: fall back to the biggest remaining hotspot
                c = hotspots[0] if hotspots else int(ctx.servers[0])
            if c not in servers_by_dist:
                servers_by_dist[c] = sorted((int(s) for s in ctx.servers), key=lambda s: D[c, s])
            placed = False
            for s in servers_by_dist[c]:
                if s not in reps[j] and ctx.fits(j, s, uc, um):
                    reps[j].append(s)
                    uc[s] += sv.cpu
                    um[s] += sv.mem
                    placed = True
                    break
            if not placed and h >= len(hotspots):
                break
    return _finish(ctx, reps, targets, "demand_first", t0)


def greedy_marginal_gain(ctx: PlacementContext, targets: Sequence[int]) -> Placement:
    t0 = time.perf_counter()
    reps, uc, um = _empty(ctx)
    cur = [np.full(ctx.clients[j].size, ctx.penalty) for j in range(ctx.J)]
    version = [0] * ctx.J
    heap: list[tuple[float, float, int, int, int]] = []
    evals = 0
    for j in range(ctx.J):
        if targets[j] == 0:
            continue
        gains = ctx.weights[j] @ np.maximum(0.0, cur[j][:, None] - ctx.Dsub[j])  # over servers
        evals += len(ctx.servers)
        for i, s in enumerate(ctx.servers):
            # tie-break: prefer servers with larger capacity
            heapq.heappush(heap, (-float(gains[i]), -ctx.cpu[int(s)], j, int(s), 0))
    while heap:
        ng, tb, j, s, ver = heapq.heappop(heap)
        if len(reps[j]) >= targets[j] or s in reps[j]:
            continue
        if not ctx.fits(j, s, uc, um):
            continue  # capacity only shrinks, so this pair is dead for good
        if ver != version[j]:
            col = ctx.col[s]
            g = float(ctx.weights[j] @ np.maximum(0.0, cur[j] - ctx.Dsub[j][:, col]))
            evals += 1
            heapq.heappush(heap, (-g, tb, j, s, version[j]))
            continue
        sv = ctx.inst.services[j]
        reps[j].append(s)
        uc[s] += sv.cpu
        um[s] += sv.mem
        cur[j] = np.minimum(cur[j], ctx.Dsub[j][:, ctx.col[s]])
        version[j] += 1
    p = _finish(ctx, reps, targets, "marginal_gain", t0)
    p.stats["gain_evaluations"] = evals
    return p


def greedy_regret(ctx: PlacementContext, targets: Sequence[int]) -> Placement:
    t0 = time.perf_counter()
    reps, uc, um = _empty(ctx)
    cur = [np.full(ctx.clients[j].size, ctx.penalty) for j in range(ctx.J)]
    remaining = {j for j in range(ctx.J) if targets[j] > 0}
    servers = [int(s) for s in ctx.servers]
    while remaining:
        best_pick = None  # (regret, gain, j, s)
        dead = []
        for j in remaining:
            ok = [i for i, s in enumerate(servers) if s not in reps[j] and ctx.fits(j, s, uc, um)]
            if not ok:
                dead.append(j)
                continue
            if ctx.clients[j].size:
                g = ctx.weights[j] @ np.maximum(0.0, cur[j][:, None] - ctx.Dsub[j][:, ok])
            else:
                g = np.zeros(len(ok))
            if len(ok) == 1:
                regret, bi = math.inf, 0
            else:
                top2 = np.argpartition(-g, 1)[:2]
                a, b = sorted(top2, key=lambda k: -g[k])
                regret, bi = float(g[a] - g[b]), int(a)
            # scale regret by remaining need so services with many replicas left go earlier
            key = (regret * (targets[j] - len(reps[j])), float(g[bi]))
            if best_pick is None or key > best_pick[0]:
                best_pick = (key, j, servers[ok[bi]])
        for j in dead:
            remaining.discard(j)
        if best_pick is None:
            break
        _, j, s = best_pick
        sv = ctx.inst.services[j]
        reps[j].append(s)
        uc[s] += sv.cpu
        um[s] += sv.mem
        cur[j] = np.minimum(cur[j], ctx.Dsub[j][:, ctx.col[s]])
        if len(reps[j]) >= targets[j]:
            remaining.discard(j)
    return _finish(ctx, reps, targets, "regret", t0)


def ffd_pack(ctx: PlacementContext, targets: Sequence[int], latency_aware: bool = True) -> Placement:
    """First-Fit-Decreasing bin packing with anti-affinity (feasibility first).

    Replicas are sorted by CPU (then memory) descending and each goes to a
    server that still fits it; with ``latency_aware`` the fitting server with
    the largest latency saving is chosen (best-fit by latency), otherwise the
    first one.  FFD uses ≤ 11/9·OPT + 6/9 bins for 1-D bin packing
    (Dósa 2007), so it finds a packing whenever capacity is not extremely tight.
    """
    t0 = time.perf_counter()
    reps, uc, um = _empty(ctx)
    svc = ctx.inst.services
    items = sorted((j for j in range(ctx.J) for _ in range(targets[j])),
                   key=lambda j: (-svc[j].cpu, -svc[j].mem))
    # pack the biggest servers first so small ones stay free for small items
    servers = sorted((int(s) for s in ctx.servers), key=lambda s: -ctx.cpu[s])
    cur = [np.full(ctx.clients[j].size, ctx.penalty) for j in range(ctx.J)]
    for j in items:
        ok = [s for s in servers if s not in reps[j] and ctx.fits(j, s, uc, um)]
        if not ok:
            continue
        if latency_aware and ctx.clients[j].size:
            # restrict to the tightest-fitting half to keep packing quality, then pick by latency
            ok.sort(key=lambda s: (ctx.cpu[s] - uc[s]) - svc[j].cpu)
            pool = ok[:max(1, (len(ok) + 1) // 2)]
            g = ctx.weights[j] @ np.maximum(0.0, cur[j][:, None] - ctx.Dsub[j][:, [ctx.col[s] for s in pool]])
            s = pool[int(np.argmax(g))]
        else:
            s = ok[0]
        reps[j].append(s)
        uc[s] += svc[j].cpu
        um[s] += svc[j].mem
        if ctx.clients[j].size:
            cur[j] = np.minimum(cur[j], ctx.Dsub[j][:, ctx.col[s]])
    res = _finish(ctx, reps, targets, "ffd_pack" if latency_aware else "ffd_plain", t0)
    if latency_aware and not res.feasible:
        # the latency-aware choice painted itself into a corner: fall back to plain FFD,
        # which sizing has already verified can pack every replica; local search then fixes latency
        plain = ffd_pack(ctx, targets, latency_aware=False)
        if plain.feasible:
            plain.strategy = "ffd_pack"
            plain.runtime_ms += res.runtime_ms
            plain.notes.append("latency-aware packing ran out of room; used plain first-fit-decreasing")
            return plain
    return res


def packing_feasible(ctx: PlacementContext, targets: Sequence[int]) -> bool:
    return ffd_pack(ctx, targets, latency_aware=False).feasible


GREEDY = {
    "random": greedy_random,
    "demand_first": greedy_demand_first,
    "marginal_gain": greedy_marginal_gain,
    "regret": greedy_regret,
    "ffd_pack": ffd_pack,
}


# -------------------------------------------------------------- local search
def local_search(ctx: PlacementContext, p: Placement, max_iters: int = 500,
                 time_limit_s: float = 10.0, eps: float = 1e-9, use_swaps: bool = True) -> Placement:
    t0 = time.perf_counter()
    q = p.copy()
    reps = q.replicas
    uc, um = ctx.usage(q)
    svc = ctx.inst.services
    start_obj = ctx.objective(q)
    moves = swaps = 0
    servers = [int(s) for s in ctx.servers]

    def cost_without(j: int, s: int) -> np.ndarray:
        """Per-client latency for service j after removing replica s."""
        cols = [ctx.col[x] for x in reps[j] if x != s]
        if not cols:
            return np.full(ctx.clients[j].size, ctx.penalty)
        return ctx.Dsub[j][:, cols].min(axis=1)

    for _ in range(max_iters):
        if time.perf_counter() - t0 > time_limit_s:
            q.notes.append("local search stopped at time limit")
            break
        best = (0.0, None)
        # --- relocate moves (vectorised over candidate targets)
        for j in range(ctx.J):
            if ctx.clients[j].size == 0:
                continue
            w = ctx.weights[j]
            base_cost = ctx.service_cost(j, reps[j])
            sv = svc[j]
            for s in reps[j]:
                base = cost_without(j, s)
                cands = [t for t in servers if t not in reps[j]
                         and uc[t] + sv.cpu <= ctx.cpu[t] + 1e-9 and um[t] + sv.mem <= ctx.mem[t] + 1e-9]
                if not cands:
                    continue
                cols = [ctx.col[t] for t in cands]
                new = w @ np.minimum(base[:, None], ctx.Dsub[j][:, cols])
                k = int(np.argmin(new))
                delta = float(new[k] - base_cost)
                if delta < best[0] - eps:
                    best = (delta, ("move", j, s, cands[k]))
        # --- swap moves: j@s <-> i@t
        if use_swaps and best[1] is None:
            placed = [(j, s) for j in range(ctx.J) for s in reps[j]]
            cache: dict[tuple[int, int], np.ndarray] = {}
            for a in range(len(placed)):
                j, s = placed[a]
                for b in range(a + 1, len(placed)):
                    i, t = placed[b]
                    if i == j or s == t or t in reps[j] or s in reps[i]:
                        continue
                    # capacity after the exchange
                    if uc[s] - svc[j].cpu + svc[i].cpu > ctx.cpu[s] + 1e-9: continue
                    if um[s] - svc[j].mem + svc[i].mem > ctx.mem[s] + 1e-9: continue
                    if uc[t] - svc[i].cpu + svc[j].cpu > ctx.cpu[t] + 1e-9: continue
                    if um[t] - svc[i].mem + svc[j].mem > ctx.mem[t] + 1e-9: continue
                    if (j, s) not in cache: cache[(j, s)] = cost_without(j, s)
                    if (i, t) not in cache: cache[(i, t)] = cost_without(i, t)
                    dj = float(ctx.weights[j] @ np.minimum(cache[(j, s)], ctx.Dsub[j][:, ctx.col[t]])) \
                        - ctx.service_cost(j, reps[j]) if ctx.clients[j].size else 0.0
                    di = float(ctx.weights[i] @ np.minimum(cache[(i, t)], ctx.Dsub[i][:, ctx.col[s]])) \
                        - ctx.service_cost(i, reps[i]) if ctx.clients[i].size else 0.0
                    if dj + di < best[0] - eps:
                        best = (dj + di, ("swap", j, s, i, t))
        if best[1] is None:
            break
        op = best[1]
        if op[0] == "move":
            _, j, s, t = op
            reps[j][reps[j].index(s)] = t
            uc[s] -= svc[j].cpu; um[s] -= svc[j].mem
            uc[t] += svc[j].cpu; um[t] += svc[j].mem
            moves += 1
        else:
            _, j, s, i, t = op
            reps[j][reps[j].index(s)] = t
            reps[i][reps[i].index(t)] = s
            uc[s] += svc[i].cpu - svc[j].cpu; um[s] += svc[i].mem - svc[j].mem
            uc[t] += svc[j].cpu - svc[i].cpu; um[t] += svc[j].mem - svc[i].mem
            swaps += 1
    q.strategy = f"{p.strategy}+ls"
    q.runtime_ms = p.runtime_ms + (time.perf_counter() - t0) * 1e3
    q.stats.update({"ls_moves": moves, "ls_swaps": swaps,
                    "ls_improvement": start_obj - ctx.objective(q)})
    return q
