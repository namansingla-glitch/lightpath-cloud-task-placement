"""Knapsack-style dynamic programs used for placement selection.

0/1 knapsack — choose a subset of items (e.g. servers to activate) maximising
total value with total weight <= W.
    OPT[i][w] = max(OPT[i-1][w], OPT[i-1][w - w_i] + v_i)
Correctness by the optimal-substructure exchange argument: an optimal set for
the first i items either excludes item i (an optimal set for i-1 items at the
same budget) or includes it (item i plus an optimal set for i-1 items at
budget w - w_i).  Theta(nW) time and space (pseudo-polynomial); weights are
integers — real costs are scaled to a grid first (``resolution``).

Multiple-choice knapsack (MCKP) — items are split into groups and exactly one
option must be taken from each group (e.g. how many replicas each service
gets).  OPT[g][w] = max over options o in group g of OPT[g-1][w - w_o] + v_o.
Theta(W * total_options) time.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence


@dataclass
class KnapsackResult:
    chosen: list[int]           # indices of chosen items (0/1) or option per group (MCKP)
    value: float
    weight: float
    feasible: bool = True
    table_cells: int = 0


def _to_int(ws: Sequence[float], resolution: float) -> list[int]:
    return [int(math.ceil(w / resolution - 1e-9)) for w in ws]


def knapsack_01(values: Sequence[float], weights: Sequence[float], capacity: float,
                resolution: float = 1.0) -> KnapsackResult:
    n = len(values)
    if n != len(weights):
        raise ValueError("values and weights must have equal length")
    if any(w < 0 for w in weights):
        raise ValueError("weights must be non-negative")
    W = int(math.floor(capacity / resolution + 1e-9))
    if W < 0:
        return KnapsackResult([], 0.0, 0.0, False)
    iw = _to_int(weights, resolution)
    # rolling 1-D table + keep[i] bitsets for reconstruction (memory n*W bits)
    best = [0.0] * (W + 1)
    keep = [bytearray(W + 1) for _ in range(n)]
    for i in range(n):
        wi, vi = iw[i], values[i]
        if vi <= 0 or wi > W:
            continue
        ki = keep[i]
        for w in range(W, wi - 1, -1):
            cand = best[w - wi] + vi
            if cand > best[w]:
                best[w] = cand
                ki[w] = 1
    # reconstruct
    w = W
    chosen = []
    for i in range(n - 1, -1, -1):
        if keep[i][w]:
            chosen.append(i)
            w -= iw[i]
    chosen.reverse()
    return KnapsackResult(chosen, sum(values[i] for i in chosen), sum(weights[i] for i in chosen),
                          True, n * (W + 1))


def multiple_choice_knapsack(groups: Sequence[Sequence[tuple[float, float]]], capacity: float,
                             resolution: float = 1.0) -> KnapsackResult:
    """groups[g] = list of (value, weight) options; pick exactly one per group.

    Returns ``chosen[g]`` = option index.  If even the cheapest combination
    exceeds the capacity, returns the cheapest combination with feasible=False.
    """
    W = int(math.floor(capacity / resolution + 1e-9))
    NEG = -math.inf
    G = len(groups)
    if W < 0:
        W = -1
    prev = [0.0] * (W + 1) if W >= 0 else []
    choice: list[list[int]] = []
    cells = 0
    for opts in groups:
        cur = [NEG] * (W + 1)
        ch = [-1] * (W + 1)
        iw = _to_int([w for _, w in opts], resolution)
        for w in range(W + 1):
            for o, (v, _) in enumerate(opts):
                wo = iw[o]
                cells += 1
                if wo <= w and prev[w - wo] != NEG:
                    cand = prev[w - wo] + v
                    if cand > cur[w]:
                        cur[w] = cand
                        ch[w] = o
        choice.append(ch)
        prev = cur
    if W < 0 or prev[W] == NEG:
        cheapest = [min(range(len(o)), key=lambda k: o[k][1]) for o in groups]
        return KnapsackResult(cheapest, sum(groups[g][c][0] for g, c in enumerate(cheapest)),
                              sum(groups[g][c][1] for g, c in enumerate(cheapest)), False, cells)
    w = W
    chosen = [0] * G
    for g in range(G - 1, -1, -1):
        o = choice[g][w]
        chosen[g] = o
        w -= int(math.ceil(groups[g][o][1] / resolution - 1e-9))
    value = sum(groups[g][c][0] for g, c in enumerate(chosen))
    weight = sum(groups[g][c][1] for g, c in enumerate(chosen))
    return KnapsackResult(chosen, value, weight, True, cells)


def fractional_knapsack_bound(values: Sequence[float], weights: Sequence[float], capacity: float) -> float:
    """Greedy LP relaxation: an upper bound on the 0/1 optimum (used in reports)."""
    items = sorted(((v / w if w > 0 else math.inf, v, w) for v, w in zip(values, weights) if v > 0),
                   reverse=True)
    total, cap = 0.0, capacity
    for _, v, w in items:
        if w <= cap:
            total += v
            cap -= w
        else:
            total += v * cap / w
            break
    return total
