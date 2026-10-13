"""Build and execute notebooks/lightpath_demo.ipynb (saved with outputs).

    python scripts/make_notebook.py
"""
from pathlib import Path

import nbformat as nbf
from nbclient import NotebookClient

ROOT = Path(__file__).resolve().parents[1]
md, code = nbf.v4.new_markdown_cell, nbf.v4.new_code_cell

cells = [
    md("# Lightpath: cloud task placement on network graphs\n\n"
       "Servers are graph nodes and link latencies are edge weights. This notebook walks through the pipeline on the "
       "project's datasets: graph algorithms (MST, Dijkstra, Bellman-Ford, Floyd–Warshall, Johnson), knapsack DP, "
       "greedy placement with local search, and the exact MILP used to measure the optimality gap.\n\n"
       "*Built by Naman Singla and Mohak Gupta, guided by Dr. Monday Jubrin Abdullahi.*"),
    code("import sys, json, time\nsys.path.insert(0, '..')\nimport numpy as np, pandas as pd\nimport matplotlib.pyplot as plt\n"
         "from cloudplace.data import build_instance\nfrom cloudplace.algorithms import (prim, kruskal, dijkstra, bellman_ford, apsp,\n"
         "    floyd_warshall_numpy, johnson, knapsack_01, NegativeCycleError)\nfrom cloudplace.model import transfer_cost_graph\n"
         "from cloudplace.solver import solve, SolveConfig\npd.set_option('display.width', 140)"),
    md("## 1. The Woxsen University campus network\nSites and their west-to-east arrangement come from the official campus map."),
    code("w = build_instance('woxsen', seed=7)\nprint(w.summary())\npd.DataFrame([{'site': a['name'], 'tier': a['tier'], 'cpu': a['cpu']} for a in w.graph.nodes]).head(12)"),
    md("## 2. Backbone: Prim and Kruskal agree (cut property)"),
    code("for heap in ['binary', 'fibonacci', 'pairing', 'lazy']:\n    r = prim(w.graph, heap=heap)\n    print(f'Prim ({heap:9s}) weight = {r.total_weight:.4f} ms, edges = {len(r.edges)}')\n"
         "k = kruskal(w.graph)\nprint(f'Kruskal            weight = {k.total_weight:.4f} ms, edges = {len(k.edges)}')"),
    md("## 3. Shortest paths from the Main Entrance (Dijkstra)"),
    code("names = [a['name'] for a in w.graph.nodes]\nd = dijkstra(w.graph, 0)\n"
         "pd.DataFrame({'site': names, 'latency_ms': np.round(d.dist, 4), 'path': [' > '.join(names[x].split(' (')[0] for x in d.path_to(t)) for t in range(len(names))]}).sort_values('latency_ms').tail(6)"),
    md("## 4. Negative transfer costs: why Bellman-Ford and Johnson\n"
       "Transfer cost is c(u→v) = base + per_ms·latency + φ(u) − φ(v). The site price levels φ create negative arcs, "
       "but they cancel around every cycle, so no negative cycle can exist."),
    code("india = build_instance('india', seed=7)\ntg = transfer_cost_graph(india.graph)\n"
         "neg = sum(1 for e in tg.edges() if e.cost < 0)\nprint('directed arcs:', tg.m, ' negative arcs:', neg)\n"
         "try:\n    dijkstra(tg, 0, 'cost')\nexcept ValueError as e:\n    print('Dijkstra refuses:', str(e)[:80], '...')\n"
         "bf = bellman_ford(tg, 0, 'cost'); jn = johnson(tg, 'cost')\nprint('Bellman-Ford and Johnson agree:', np.allclose(bf.dist, jn.dist[0]))"),
    md("## 5. All-pairs: the automatic choice"),
    code("for name in ['india', 'nigeria', 'er-100']:\n    inst = build_instance({'er-100': 'erdos_renyi'}.get(name, name), n=100, seed=7, p=0.05)\n"
         "    t = time.perf_counter(); r = apsp(inst.graph); ms = (time.perf_counter() - t) * 1e3\n"
         "    print(f'{name:8s} n={inst.graph.n:3d} density={inst.graph.density():.3f} -> {r.algorithm:24s} {ms:7.2f} ms')"),
    md("## 6. Knapsack DP: choosing servers within a budget"),
    code("vals, wts = [60, 100, 120, 80, 30], [10, 20, 30, 15, 5]\nr = knapsack_01(vals, wts, 50)\nprint('chosen items', r.chosen, 'value', r.value, 'weight', r.weight)"),
    md("## 7. Full placement on India and Nigeria"),
    code("rows = []\nfor region in ['india', 'nigeria']:\n    inst = build_instance(region, seed=7)\n    out = solve(inst, SolveConfig())\n"
         "    for s in out['strategies']:\n        rows.append({'region': region, 'strategy': s['name'], 'mean_ms': s['mean_ms'], 'p95_ms': s['p95_ms'], 'gap_%': s['gap_pct'], 'runtime_ms': s['runtime_ms']})\n"
         "    if region == 'india':\n        india_out, india_inst = out, inst\npd.DataFrame(rows).pivot(index='strategy', columns='region', values='mean_ms').sort_values('india')"),
    code("for line in india_out['recommendations']:\n    print('•', line)"),
    md("## 8. The India plan on a map"),
    code("g = india_inst.graph; best = next(s for s in india_out['strategies'] if s['name'] == india_out['best'])\n"
         "hosts = {s for S in best['replicas'].values() for s in S}\nfig, ax = plt.subplots(figsize=(7, 7))\n"
         "for e in g.edges():\n    a, b = g.nodes[e.u], g.nodes[e.v]; ax.plot([a['x'], b['x']], [a['y'], b['y']], color='#4285F4', alpha=.35, lw=1)\n"
         "for r in india_out['policy']['routes'][:40]:\n    p = r['path']; ax.plot([g.nodes[i]['x'] for i in p], [g.nodes[i]['y'] for i in p], color='#1A73E8', lw=2, alpha=.5)\n"
         "for i, a in enumerate(g.nodes):\n    ax.scatter(a['x'], a['y'], s=70 if i in hosts else 25, c='#FBBC05' if i in hosts else 'white', edgecolors='#202124', zorder=3)\n"
         "    ax.annotate(a['name'], (a['x'] + 8, a['y'] + 4), fontsize=7, color='#5F6368')\n"
         "ax.invert_yaxis(); ax.set_aspect('equal'); ax.axis('off'); ax.set_title(f\"India: {best['name']} placement, mean {best['mean_ms']} ms\")\nplt.show()"),
    md("## 9. Experiment highlights\nThe full suite (`experiments/run_experiments.py`) writes CSVs and the report figures."),
    code("R = json.load(open('../experiments/results/summary.json'))['results']\nq = pd.DataFrame(R['quality_size'])\n"
         "q[q.gap_pct.notna()].groupby('strategy').gap_pct.agg(['mean', 'max']).round(2).sort_values('mean')"),
    code("from IPython.display import Image, display\ndisplay(Image('../experiments/figures/e4_quality_size.png', width=900))\ndisplay(Image('../experiments/figures/e5_capacity.png', width=900))"),
]

nb = nbf.v4.new_notebook(cells=cells, metadata={"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}})
out = ROOT / "notebooks" / "lightpath_demo.ipynb"
out.parent.mkdir(exist_ok=True)
NotebookClient(nb, timeout=300, kernel_name="python3", resources={"metadata": {"path": str(out.parent)}}).execute()
nbf.write(nb, out)
print("wrote", out)
