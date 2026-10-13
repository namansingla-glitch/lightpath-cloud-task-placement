"""Export instances / solutions to GEXF (Gephi) and CSV."""
from __future__ import annotations

import csv
from pathlib import Path
from typing import Any
from xml.sax.saxutils import quoteattr

from ..model.instance import Instance

TIER_RGB = {"core": (124, 92, 255), "regional": (34, 211, 238), "edge": (52, 211, 153), "router": (148, 163, 184)}


def to_gexf(inst: Instance, path: str | Path, solution: dict[str, Any] | None = None) -> None:
    """Write GEXF 1.3 with tier colours, coordinates and (optionally) MST / replica flags."""
    g = inst.graph
    mst_edges = set()
    hosts: dict[int, list[str]] = {}
    if solution:
        for e in solution["topology"]["mst"]["edges"]:
            mst_edges.add((min(e["u"], e["v"]), max(e["u"], e["v"])))
        best = next(s for s in solution["strategies"] if s["name"] == solution["best"])
        for j, S in best["replicas"].items():
            for s in S:
                hosts.setdefault(s, []).append(inst.services[int(j)].name)
    L = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<gexf xmlns="http://gexf.net/1.3" xmlns:viz="http://gexf.net/1.3/viz" version="1.3">',
         f'<meta><creator>cloudplace</creator><description>{inst.description}</description></meta>',
         '<graph defaultedgetype="undirected" mode="static">',
         '<attributes class="node">'
         '<attribute id="0" title="tier" type="string"/><attribute id="1" title="cpu" type="double"/>'
         '<attribute id="2" title="mem" type="double"/><attribute id="3" title="replicas" type="string"/>'
         '</attributes>',
         '<attributes class="edge"><attribute id="0" title="latency_ms" type="double"/>'
         '<attribute id="1" title="bandwidth_gbps" type="double"/><attribute id="2" title="mst" type="boolean"/>'
         '</attributes>', '<nodes>']
    for i, a in enumerate(g.nodes):
        r, gg, b = TIER_RGB.get(a.get("tier", "router"), (200, 200, 200))
        size = 6 + (a.get("cpu", 0) or 0) / 8
        L.append(f'<node id="{i}" label={quoteattr(str(a.get("name", i)))}><attvalues>'
                 f'<attvalue for="0" value={quoteattr(str(a.get("tier", "")))}/>'
                 f'<attvalue for="1" value="{a.get("cpu", 0)}"/><attvalue for="2" value="{a.get("mem", 0)}"/>'
                 f'<attvalue for="3" value={quoteattr(";".join(hosts.get(i, [])))}/></attvalues>'
                 f'<viz:color r="{r}" g="{gg}" b="{b}"/><viz:size value="{size:.1f}"/>'
                 f'<viz:position x="{a.get("x", 0)}" y="{-a.get("y", 0)}" z="0"/></node>')
    L.append('</nodes><edges>')
    for k, e in enumerate(g.edges()):
        in_mst = (min(e.u, e.v), max(e.u, e.v)) in mst_edges
        L.append(f'<edge id="{k}" source="{e.u}" target="{e.v}" weight="{1.0 / max(e.latency, 1e-6):.4f}">'
                 f'<attvalues><attvalue for="0" value="{e.latency}"/><attvalue for="1" value="{e.bandwidth}"/>'
                 f'<attvalue for="2" value="{str(in_mst).lower()}"/></attvalues></edge>')
    L.append('</edges></graph></gexf>')
    Path(path).write_text("\n".join(L))


def rows_to_csv(rows: list[dict[str, Any]], path: str | Path) -> None:
    if not rows:
        Path(path).write_text("")
        return
    keys = list(dict.fromkeys(k for r in rows for k in r))
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        for r in rows:
            w.writerow({k: (" > ".join(map(str, v)) if isinstance(v, list) else v) for k, v in r.items()})
