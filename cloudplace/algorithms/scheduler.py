"""Greedy batch-task scheduler (list scheduling with network-aware EFT).

Each server s offers ``slots(s)`` parallel execution lanes.  A task t whose
input lives at node a(t) can run on s after its data arrives:
    ready(t, s) = latency(a, s)/1000 + data_gb·8 / bottleneck_bw(a, s)   [s]
    finish(t, s, lane) = max(free(lane), ready(t, s)) + duration(t)
Tasks are ordered by a rule (LPT = longest processing time first, or by
priority) and each one is assigned to the (server, lane) with the Earliest
Finish Time.  O(T · S · log L) with a heap of lanes per server.

Guarantee (LPT, identical machines, no transfer delays): makespan ≤ (4/3 − 1/3m)·OPT
(Graham 1969); network delays make it a heuristic, but the ordering argument
still applies to the compute part.
"""
from __future__ import annotations

import heapq
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..model.instance import Instance


@dataclass
class Schedule:
    entries: list[dict[str, Any]] = field(default_factory=list)
    makespan: float = 0.0
    rule: str = "lpt"
    runtime_ms: float = 0.0
    utilisation: dict[int, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"entries": self.entries, "makespan": self.makespan, "rule": self.rule,
                "runtime_ms": self.runtime_ms,
                "utilisation": {str(k): v for k, v in self.utilisation.items()}}


def slots_of(inst: Instance, s: int, cores_per_slot: int = 8) -> int:
    return max(1, int(inst.cpu(s) // cores_per_slot))


def schedule_batch(inst: Instance, D: np.ndarray, bottleneck: np.ndarray | None = None,
                   rule: str = "lpt", servers: list[int] | None = None,
                   cores_per_slot: int = 8) -> Schedule:
    t0 = time.perf_counter()
    servers = servers if servers is not None else inst.servers
    tasks = list(inst.tasks)
    if rule == "lpt":
        tasks.sort(key=lambda t: -t.duration)
    elif rule == "priority":
        tasks.sort(key=lambda t: (-t.priority, -t.duration))
    elif rule == "fifo":
        pass
    else:
        raise ValueError(f"unknown rule {rule}")
    lanes = {s: [(0.0, k) for k in range(slots_of(inst, s, cores_per_slot))] for s in servers}
    for h in lanes.values():
        heapq.heapify(h)
    busy = {s: 0.0 for s in servers}
    entries = []
    for t in tasks:
        best = None
        for s in servers:
            lat = D[t.data_node, s]
            if not np.isfinite(lat):
                continue
            bw = 1e9 if t.data_node == s else (bottleneck[t.data_node, s] if bottleneck is not None else 10.0)
            ready = lat / 1000.0 + (t.data_gb * 8.0 / bw if t.data_node != s else 0.0)
            free, lane = lanes[s][0]
            start = max(free, ready)
            fin = start + t.duration
            if best is None or fin < best[0] - 1e-12:
                best = (fin, start, s, lane, ready)
        if best is None:
            continue
        fin, start, s, lane, ready = best
        heapq.heapreplace(lanes[s], (fin, lane))
        busy[s] += t.duration
        entries.append({"task": t.id, "name": t.name, "server": s, "lane": lane,
                        "start": round(start, 4), "end": round(fin, 4),
                        "transfer": round(ready, 4), "data_node": t.data_node})
    makespan = max((e["end"] for e in entries), default=0.0)
    util = {s: (busy[s] / (makespan * slots_of(inst, s, cores_per_slot)) if makespan else 0.0)
            for s in servers}
    return Schedule(entries, makespan, rule, (time.perf_counter() - t0) * 1e3, util)


def bottleneck_matrix(inst: Instance, apsp_res: Any, sources: list[int] | None = None) -> np.ndarray:
    """Bandwidth of the narrowest link on each chosen shortest path (rows = sources)."""
    n = inst.graph.n
    B = np.full((n, n), np.inf)
    for u in (sources if sources is not None else range(n)):
        for v in range(n):
            if u == v:
                continue
            path = apsp_res.path(u, v)
            if len(path) < 2:
                B[u, v] = 0.0
                continue
            B[u, v] = min(inst.graph.edge(a, b).bandwidth for a, b in zip(path, path[1:]))
    return B
