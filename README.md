# Lightpath — latency-aware cloud task placement

Servers are graph nodes, link latencies are edge weights. The project places service
replicas / VMs to **minimise demand-weighted average latency** while respecting
**CPU / memory capacity** and a **budget**, using:

| Stage | Algorithm | Complexity |
|---|---|---|
| Latency matrix | Floyd–Warshall (dense) · Johnson / repeated Dijkstra (sparse) — chosen automatically | Θ(V³) · O(VE log V) |
| Backbone | MST — Prim (binary / Fibonacci / pairing heap) · Kruskal (union-find) | O(E log V) · O(E log E) |
| Routing | Dijkstra (non-negative) · Bellman-Ford (negative rebate arcs) | O(E log V) · O(VE) |
| Server activation | 0/1 knapsack DP | Θ(nW) |
| Replica sizing | Multiple-choice knapsack DP | Θ(W·Σoptions) |
| Placement | Greedy: demand-first, CELF marginal-gain, regret, FFD packing | see report |
| Refinement | Relocate + swap local search | per pass O(Σk·S·C) |
| Optimality check | Exact MILP (HiGHS) + LP lower bound | exponential worst case |
| Batch schedule | Network-aware LPT / earliest-finish-time list scheduling | O(T·S log L) |

## Quick start

```bash
pip install -r requirements.txt
python -m pytest -q                      # 179 tests (NetworkX + brute-force oracles)
python scripts/build_datasets.py         # regenerate datasets/ (JSON, GEXF, policy CSVs)
python experiments/run_experiments.py    # ~80 s → experiments/results + figures
uvicorn api.server:app --port 8000       # REST API for the dashboard
```

Minimal use from Python:

```python
from cloudplace.data import build_instance
from cloudplace.solver import solve, SolveConfig

inst = build_instance("india", seed=7, services=8)
result = solve(inst, SolveConfig(vm_budget=5.0))
print(result["best"], result["recommendations"])
```

## Repository layout

```
cloudplace/
  core/        graph (adjacency lists), heaps (binary, Fibonacci, pairing, lazy), union-find
  algorithms/  mst, sssp, apsp, knapsack, placement (greedy + local search), exact (MILP), scheduler
  model/       problem formulation (instance.py), transfer-cost graph with negative arcs (costs.py)
  data/        generators (Waxman, Erdős–Rényi, Barabási–Albert, fat-tree, Abilene, NSFNET, India, campus), GEXF export
  solver.py    end-to-end pipeline + policy outputs
api/           FastAPI server (datasets, generate, solve, algorithm traces, experiments)
datasets/      9 sample instances (*.json), Gephi files (gexf/), policy tables (policies/*.csv)
experiments/   run_experiments.py, results/*.csv, figures/*.png
scripts/       build_datasets.py, export_demo.py (static snapshot for the dashboard)
tests/         pytest suite
web/           dashboard (in design)
```

## Datasets

| Name | Source | Nodes / links |
|---|---|---|
| abilene | Internet2 Abilene backbone (real topology) | 11 / 14 |
| nsfnet | NSFNET T1 backbone (real topology) | 14 / 21 |
| india | 24 Indian metros, real coordinates, geographic 3-NN mesh | 24 / 42 |
| campus | hand-built university campus | 20 / 29 |
| fat-tree-k4 | k=4 data-centre fat-tree | 36 / 48 |
| waxman-60, waxman-60-tight | Waxman geographic WAN (nominal and 0.5× capacity) | 60 / 89 |
| er-100 | Erdős–Rényi | 100 / 350 |
| ba-150 | Barabási–Albert scale-free | 150 / 296 |

Latency model: 1.3 × great-circle km / 200 km·ms⁻¹ + 0.3 ms switching. Open any
`datasets/gexf/*.gexf` in Gephi — nodes are coloured by tier, edges carry an `mst` flag
and nodes list the replicas placed on them.

## Headline results (experiments/)

* Greedy + local search is within **0.3 % of the proven MILP optimum on average** (max 2.1 %) for n ≤ 160,
  at 10–100× lower runtime; at n = 240 the comparison is against the LP lower bound.
* Under tight capacity the latency-first greedies fail to find any feasible placement in many runs,
  while **FFD packing + local search stays feasible** — feasibility and latency pull in different directions.
* Fibonacci heaps are asymptotically better but **slower in CPython** than binary heaps; stdlib `heapq`
  with lazy deletion is fastest in practice.
* The automatic APSP rule picks repeated Dijkstra on sparse graphs and vectorised Floyd–Warshall on dense ones.
