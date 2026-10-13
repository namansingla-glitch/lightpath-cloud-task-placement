"""Pre-compute API responses into web/public/demo so the dashboard also works
without the Python backend (static hosting / offline demo).

    python scripts/export_demo.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from api.server import app  # noqa: E402

OUT = ROOT / "web" / "public" / "demo"
ALGOS = ["prim", "kruskal", "dijkstra", "bellman_ford", "floyd_warshall", "johnson"]


def dump(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":")))


def main() -> None:
    c = TestClient(app)
    index = c.get("/api/datasets").json()
    dump(OUT / "datasets.json", index)
    for d in index:
        name = d["name"]
        dump(OUT / "datasets" / f"{name}.json", c.get(f"/api/datasets/{name}").json())
        r = c.post("/api/solve", json={"dataset": name, "config": {}})
        r.raise_for_status()
        dump(OUT / "solve" / f"{name}.json", r.json())
        if d["nodes"] <= 60:
            for alg in ALGOS:
                r = c.post("/api/algorithms/run", json={"dataset": name, "algorithm": alg, "source": 0})
                if r.status_code == 200:
                    dump(OUT / "algo" / name / f"{alg}.json", r.json())
        print("exported", name)
    e = c.get("/api/experiments")
    if e.status_code == 200:
        dump(OUT / "experiments.json", e.json())
    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"demo snapshot: {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
