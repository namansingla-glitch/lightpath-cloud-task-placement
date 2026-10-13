"""Pre-compute API responses into web/public/demo so the dashboard also works
without the Python backend (static hosting / offline demo).

    python scripts/export_demo.py
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from api.server import app  # noqa: E402

OUT = ROOT / "web" / "public" / "demo"
PER_SOURCE_MAX = 30
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
            if d["nodes"] <= PER_SOURCE_MAX:  # every start city, so the offline lab can start anywhere
                for alg in ("dijkstra", "bellman_ford", "prim"):
                    for s in range(1, d["nodes"]):
                        r = c.post("/api/algorithms/run", json={"dataset": name, "algorithm": alg, "source": s})
                        if r.status_code == 200:
                            dump(OUT / "algo" / name / f"{alg}-{s}.json", r.json())
        print("exported", name)
    # static downloads used by the Data page (identical in live and snapshot mode)
    files = OUT / "files"
    if files.exists():
        shutil.rmtree(files)
    for sub in ("", "gexf", "policies"):
        src = ROOT / "datasets" / sub
        dst = files / sub
        dst.mkdir(parents=True, exist_ok=True)
        for f in src.iterdir():
            if f.is_file() and f.suffix in (".json", ".gexf", ".csv"):
                shutil.copy2(f, dst / f.name)
    figs = ROOT / "experiments" / "figures"
    if figs.exists():
        shutil.copytree(figs, files / "figures", dirs_exist_ok=True)
    for f in (ROOT / "experiments" / "results").glob("*.csv"):
        (files / "results").mkdir(exist_ok=True)
        shutil.copy2(f, files / "results" / f.name)
    e = c.get("/api/experiments")
    if e.status_code == 200:
        dump(OUT / "experiments.json", e.json())
    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"demo snapshot: {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
