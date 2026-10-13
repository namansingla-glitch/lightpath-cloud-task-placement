"""FastAPI backend for the dashboard.

    uvicorn api.server:app --reload --port 8000

Endpoints
    GET  /api/health
    GET  /api/datasets                 list bundled datasets
    GET  /api/datasets/{name}          one instance (graph + services + tasks)
    POST /api/generate                 synthesise a new instance
    POST /api/solve                    run the full placement pipeline
    POST /api/algorithms/run           run one graph algorithm with a step trace
    GET  /api/experiments              experiment results (summary.json)
If web/dist exists it is served at /, so one process hosts the whole app.
"""
from __future__ import annotations

import json
import math
import sys
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from cloudplace.algorithms import (NegativeCycleError, bellman_ford, dijkstra, floyd_warshall_numpy,  # noqa: E402
                                   johnson, kruskal, prim)
from cloudplace.algorithms.apsp import choose_apsp  # noqa: E402
from cloudplace.data.generators import build_instance  # noqa: E402
from cloudplace.model import Instance, transfer_cost_graph  # noqa: E402
from cloudplace.solver import SolveConfig, solve  # noqa: E402

DATA = ROOT / "datasets"
RESULTS = ROOT / "experiments" / "results" / "summary.json"
DIST = ROOT / "web" / "dist"
MAX_TRACE = 6000
MAX_NODES = 600

app = FastAPI(title="cloudplace API", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@lru_cache(maxsize=32)
def _load_dataset(name: str) -> str:
    p = DATA / f"{name}.json"
    if not p.exists() or "/" in name or ".." in name:
        raise HTTPException(404, f"dataset '{name}' not found")
    return p.read_text()


def _instance(dataset: str | None, instance: dict[str, Any] | None) -> Instance:
    if instance:
        try:
            inst = Instance.from_dict(instance)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(422, f"invalid instance: {exc}") from exc
    elif dataset:
        inst = Instance.from_dict(json.loads(_load_dataset(dataset)))
    else:
        raise HTTPException(422, "provide 'dataset' or 'instance'")
    if inst.graph.n > MAX_NODES:
        raise HTTPException(413, f"instance too large for interactive use (> {MAX_NODES} nodes)")
    return inst


def _clean(x: Any) -> Any:
    """Make numpy / inf values JSON-safe."""
    if isinstance(x, dict):
        return {str(k): _clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_clean(v) for v in x]
    if isinstance(x, (np.floating, float)):
        f = float(x)
        return None if not math.isfinite(f) else f
    if isinstance(x, np.integer):
        return int(x)
    if isinstance(x, np.ndarray):
        return _clean(x.tolist())
    return x


class GenerateReq(BaseModel):
    model: str = "waxman"
    n: int = Field(30, ge=4, le=MAX_NODES)
    seed: int = 0
    services: int = Field(6, ge=1, le=40)
    tasks: int = Field(12, ge=0, le=200)
    capacity_factor: float = Field(1.0, gt=0, le=10)
    budget_factor: float = Field(1.6, gt=0, le=20)
    params: dict[str, Any] = {}


class SolveReq(BaseModel):
    dataset: str | None = None
    instance: dict[str, Any] | None = None
    config: dict[str, Any] = {}


class AlgoReq(BaseModel):
    dataset: str | None = None
    instance: dict[str, Any] | None = None
    algorithm: str = "dijkstra"
    source: int = 0
    heap: str = "binary"
    weight: str = "latency"


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "version": "1.0.0"}


@app.get("/api/datasets")
def datasets() -> list[dict[str, Any]]:
    p = DATA / "index.json"
    return json.loads(p.read_text()) if p.exists() else []


@app.get("/api/datasets/{name}")
def dataset(name: str) -> dict[str, Any]:
    d = json.loads(_load_dataset(name))
    d["summary"] = Instance.from_dict(d).summary()
    return d


@app.post("/api/generate")
def generate(req: GenerateReq) -> dict[str, Any]:
    try:
        inst = build_instance(req.model, n=req.n, seed=req.seed, services=req.services, tasks=req.tasks,
                              capacity_factor=req.capacity_factor, budget_factor=req.budget_factor, **req.params)
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from exc
    d = inst.to_dict()
    d["summary"] = inst.summary()
    return d


@app.post("/api/solve")
def solve_ep(req: SolveReq) -> dict[str, Any]:
    inst = _instance(req.dataset, req.instance)
    cfg = SolveConfig.from_dict(req.config)
    cfg.exact_time_limit_s = min(cfg.exact_time_limit_s, 20.0)
    return _clean(solve(inst, cfg))


@app.post("/api/algorithms/run")
def run_algorithm(req: AlgoReq) -> dict[str, Any]:
    inst = _instance(req.dataset, req.instance)
    g = inst.graph
    if not 0 <= req.source < g.n:
        raise HTTPException(422, "source out of range")
    t0 = time.perf_counter()
    try:
        if req.algorithm == "prim":
            res = prim(g, heap=req.heap, root=req.source, trace=True).to_dict()
        elif req.algorithm == "kruskal":
            res = kruskal(g, trace=True).to_dict()
        elif req.algorithm == "dijkstra":
            res = dijkstra(g, req.source, heap=req.heap, trace=True).to_dict()
        elif req.algorithm == "bellman_ford":
            tg = transfer_cost_graph(g)
            r = bellman_ford(tg, req.source, "cost", trace=True)
            res = r.to_dict()
            res["negative_arcs"] = [[e.u, e.v, e.cost] for e in tg.edges() if (e.cost or 0) < 0]
        elif req.algorithm in ("floyd_warshall", "johnson"):
            if req.algorithm == "johnson":
                tg = transfer_cost_graph(g)
                r = johnson(tg, "cost", heap=req.heap)
                choice = choose_apsp(tg, "cost")
            else:
                r = floyd_warshall_numpy(g)
                choice = choose_apsp(g)
            res = r.to_dict()
            res["auto_choice"] = choice
        else:
            raise HTTPException(422, f"unknown algorithm {req.algorithm}")
    except NegativeCycleError as exc:
        raise HTTPException(409, str(exc)) from exc
    res["runtime_ms"] = round((time.perf_counter() - t0) * 1e3, 3)
    tr = res.get("trace") or []
    res["trace_truncated"] = len(tr) > MAX_TRACE
    res["trace"] = tr[:MAX_TRACE]
    return _clean(res)


@app.get("/api/experiments")
def experiments() -> dict[str, Any]:
    if not RESULTS.exists():
        raise HTTPException(404, "run experiments/run_experiments.py first")
    return json.loads(RESULTS.read_text())


if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    DIST_ROOT = DIST.resolve()

    @app.get("/{path:path}")
    def spa(path: str) -> FileResponse:
        if path.startswith("api/") or path == "api":
            raise HTTPException(404, "not found")
        f = (DIST / path).resolve()
        # only serve files that really live inside web/dist (no ../ escapes)
        if path and f.is_file() and f.is_relative_to(DIST_ROOT):
            return FileResponse(f)
        return FileResponse(DIST / "index.html")
