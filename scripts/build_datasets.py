"""Generate the sample datasets shipped in datasets/ (JSON + GEXF + solved policy CSVs).

    python scripts/build_datasets.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cloudplace.data.export import rows_to_csv, to_gexf  # noqa: E402
from cloudplace.data.generators import build_instance  # noqa: E402
from cloudplace.solver import SolveConfig, solve  # noqa: E402

SPECS = [
    # name,            model,             kwargs
    ("abilene",        "abilene",         dict(services=6, tasks=12)),
    ("nsfnet",         "nsfnet",          dict(services=7, tasks=14)),
    ("india",          "india",           dict(services=8, tasks=16)),
    ("nigeria",        "nigeria",         dict(services=8, tasks=16)),
    ("woxsen",         "woxsen",          dict(tasks=12)),
    ("fat-tree-k4",    "fat_tree",        dict(services=6, tasks=12, k=4)),
    ("waxman-60",      "waxman",          dict(n=60, services=14, tasks=20)),
    ("er-100",         "erdos_renyi",     dict(n=100, services=16, tasks=24, p=0.05)),
    ("ba-150",         "barabasi_albert", dict(n=150, services=20, tasks=24, m=2)),
    ("waxman-60-tight", "waxman",         dict(n=60, services=14, tasks=20, capacity_factor=0.5)),
]


def main() -> None:
    out = ROOT / "datasets"
    out.mkdir(exist_ok=True)
    (out / "gexf").mkdir(exist_ok=True)
    (out / "policies").mkdir(exist_ok=True)
    index = []
    for name, model, kw in SPECS:
        inst = build_instance(model, seed=7, name=name, **kw)
        inst.save(out / f"{name}.json")
        sol = solve(inst, SolveConfig())
        to_gexf(inst, out / "gexf" / f"{name}.gexf", sol)
        pol = sol["policy"]
        rows_to_csv(pol.get("routes", []), out / "policies" / f"{name}_routes.csv")
        rows_to_csv([{**r, "vms": ";".join(r["vms"])} for r in pol["schedule"]],
                    out / "policies" / f"{name}_schedule.csv")
        rows_to_csv(sol["sizing"]["table"], out / "policies" / f"{name}_cost_benefit.csv")
        rows_to_csv([{k: v for k, v in s.items() if k not in ("replicas", "stats", "notes", "violations")}
                     for s in sol["strategies"]], out / "policies" / f"{name}_strategies.csv")
        index.append({"name": name, "model": model, "description": inst.description, "source": inst.source,
                      **inst.summary(), "best": sol["best"],
                      "region": inst.meta.get("region", "global"),
                      "preview": {"n": [[round(a["x"]), round(a["y"]), a.get("tier", "router")] for a in inst.graph.nodes],
                                  "e": [[e.u, e.v] for e in inst.graph.edges()]},
                      "best_mean_ms": next(s["mean_ms"] for s in sol["strategies"] if s["name"] == sol["best"])})
        print(f"{name:16s} n={inst.graph.n:4d} m={inst.graph.m:4d} best={sol['best']}")
    (out / "index.json").write_text(json.dumps(index, indent=1))


if __name__ == "__main__":
    main()
