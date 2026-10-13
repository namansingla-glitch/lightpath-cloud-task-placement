"""Problem formulation.

Network  G = (V, E): V are sites (servers, routers, client PoPs); each link
(u,v) has latency l_uv (ms), bandwidth b_uv (Gbit/s) and a directed transfer
cost c_uv ($/GB) that may be negative on peering arcs (rebates).

Servers  S ⊆ V with CPU capacity C_s (vCPU), memory M_s (GB) and an hourly
activation cost f_s.  Routers / client sites have C_s = 0 and cannot host.

Services J: service j needs cpu_j vCPU and mem_j GB per replica, costs p_j
per replica-hour, has priority π_j and client demand r_{jc} (requests/s) at
client sites c.  Replicas k_j ∈ [kmin_j, kmax_j].

Decision  y_{sj} ∈ {0,1}: a replica of j runs on s (anti-affinity: ≤ 1 per
server).  Each client is routed to its nearest replica along a shortest path.

Objective (minimise demand-weighted mean latency)
    L(y) = Σ_j Σ_c π_j r_{jc} · min_{s: y_sj = 1} d(c, s)  /  Σ_j Σ_c π_j r_{jc}
where d is the all-pairs shortest-path latency.

Constraints
    Σ_s y_{sj} = k_j                       (replica count)
    Σ_j cpu_j y_{sj} ≤ C_s,  Σ_j mem_j y_{sj} ≤ M_s   (capacity)
    Σ_j p_j k_j + Σ_{s used} f_s ≤ B       (budget, optional)

This is a capacitated, multi-commodity k-median problem (NP-hard: it contains
k-median), so we combine exact DP for the budget-selection sub-problems with
greedy + local search for placement, and an exact MILP on small instances to
measure the optimality gap.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ..core.graph import Graph


@dataclass
class Service:
    id: int
    name: str
    cpu: float
    mem: float
    demand: dict[int, float]            # client node -> request rate
    min_replicas: int = 1
    max_replicas: int = 4
    vm_cost: float = 0.10               # $ per replica-hour
    priority: float = 1.0
    color: str | None = None

    @property
    def total_demand(self) -> float:
        return sum(self.demand.values())

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["demand"] = {str(k): v for k, v in self.demand.items()}
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Service":
        d = dict(d)
        d["demand"] = {int(k): float(v) for k, v in d["demand"].items()}
        return cls(**d)


@dataclass
class BatchTask:
    id: int
    name: str
    duration: float        # seconds of compute on one slot
    data_node: int         # where the input data lives
    data_gb: float = 1.0
    priority: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Instance:
    name: str
    graph: Graph
    services: list[Service]
    tasks: list[BatchTask] = field(default_factory=list)
    budget: float | None = None          # $/hour for VMs + activated servers
    description: str = ""
    source: str = "synthetic"
    meta: dict[str, Any] = field(default_factory=dict)

    # convenient views --------------------------------------------------
    @property
    def servers(self) -> list[int]:
        return [i for i, a in enumerate(self.graph.nodes) if a.get("cpu", 0) > 0]

    def cpu(self, s: int) -> float:
        return float(self.graph.nodes[s].get("cpu", 0))

    def mem(self, s: int) -> float:
        return float(self.graph.nodes[s].get("mem", 0))

    def server_cost(self, s: int) -> float:
        return float(self.graph.nodes[s].get("cost", 0.0))

    def total_capacity(self) -> tuple[float, float]:
        return (sum(self.cpu(s) for s in self.servers), sum(self.mem(s) for s in self.servers))

    def summary(self) -> dict[str, Any]:
        cpu, mem = self.total_capacity()
        need_cpu = sum(sv.cpu * sv.min_replicas for sv in self.services)
        return {
            "name": self.name, "nodes": self.graph.n, "links": self.graph.m,
            "servers": len(self.servers), "services": len(self.services),
            "tasks": len(self.tasks), "density": round(self.graph.density(), 4),
            "cpu_capacity": cpu, "mem_capacity": mem,
            "cpu_demand_min": need_cpu,
            "cpu_load_min": round(need_cpu / cpu, 3) if cpu else None,
            "connected": self.graph.is_connected(),
        }

    def validate(self) -> list[str]:
        errs = []
        n = self.graph.n
        if not self.graph.is_connected():
            errs.append("graph is not connected; unreachable clients get infinite latency")
        if not self.servers:
            errs.append("no node has cpu > 0, nothing can host a replica")
        for sv in self.services:
            if sv.min_replicas < 1 or sv.max_replicas < sv.min_replicas:
                errs.append(f"service {sv.name}: invalid replica bounds")
            for c in sv.demand:
                if not 0 <= c < n:
                    errs.append(f"service {sv.name}: demand at unknown node {c}")
            fits = [s for s in self.servers if self.cpu(s) >= sv.cpu and self.mem(s) >= sv.mem]
            if len(fits) < sv.min_replicas:
                errs.append(f"service {sv.name}: only {len(fits)} servers can host one replica")
        for e in self.graph.edges():
            if e.latency < 0:
                errs.append(f"link {e.u}-{e.v} has negative latency")
        return errs

    # io -----------------------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name, "description": self.description, "source": self.source,
            "budget": self.budget, "meta": self.meta,
            "graph": self.graph.to_dict(),
            "services": [s.to_dict() for s in self.services],
            "tasks": [t.to_dict() for t in self.tasks],
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Instance":
        return cls(
            name=d["name"], graph=Graph.from_dict(d["graph"]),
            services=[Service.from_dict(s) for s in d.get("services", [])],
            tasks=[BatchTask(**t) for t in d.get("tasks", [])],
            budget=d.get("budget"), description=d.get("description", ""),
            source=d.get("source", "synthetic"), meta=d.get("meta", {}),
        )

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), indent=1))

    @classmethod
    def load(cls, path: str | Path) -> "Instance":
        return cls.from_dict(json.loads(Path(path).read_text()))
