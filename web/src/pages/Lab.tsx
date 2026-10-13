import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import NetworkMap, { ekey, type EdgeMark } from "../components/NetworkMap";
import { Info } from "../components/Help";
import { getDataset, getDatasets, runAlgorithm } from "../lib/api";
import { fmt, shortName, useApp, useAsync } from "../lib/app";
import type { AlgoResult, Instance } from "../lib/types";
import { answerStep, fastestPath, fromParent, pathLatency, treePath } from "../lib/routes";

type Alg = "prim" | "kruskal" | "dijkstra" | "bellman_ford" | "floyd_warshall" | "johnson";
const ALGS: { k: Alg; name: string; tag: string; heap: boolean; source: boolean; pseudo: string[]; cx: string; why: string; what: string }[] = [
  { k: "prim", name: "Prim", tag: "minimum spanning tree", heap: true, source: true, cx: "O((V+E) log V) with a binary heap; O(E + V log V) with a Fibonacci heap",
    what: "Grows one tree from the start city, always adding the cheapest link that reaches a new site. The result is the cheapest backbone that connects everything.",
    why: "Cut property: the lightest link crossing any split of the sites belongs to some minimum spanning tree, and Prim always takes exactly such a link.",
    pseudo: ["key[v] ← ∞ for all v; key[root] ← 0", "Q ← all vertices (priority queue on key)", "while Q is not empty:", "  u ← extract-min(Q); add u to the tree", "  for each link (u, v, w):", "    if v not in tree and w < key[v]:", "      key[v] ← w; parent[v] ← u", "      decrease-key(Q, v, w)"] },
  { k: "kruskal", name: "Kruskal", tag: "minimum spanning tree", heap: false, source: false, cx: "O(E log E) to sort + O(E α(V)) for union-find",
    what: "Looks at every link from cheapest to most expensive and keeps it unless it would close a loop. Union-find tracks which sites are already joined.",
    why: "Cut property again: each kept link is the lightest one joining two separate groups of sites.",
    pseudo: ["sort links by weight", "make-set(v) for every vertex", "for each link (u, v, w) in order:", "  if find(u) ≠ find(v):", "    add (u, v) to the tree", "    union(u, v)", "  else: skip, it would close a cycle"] },
  { k: "dijkstra", name: "Dijkstra", tag: "shortest paths", heap: true, source: true, cx: "O((V+E) log V) with a binary heap; O(E + V log V) with a Fibonacci heap",
    what: "Finds the fastest route from the start city to every other site, settling sites in order of distance.",
    why: "With non-negative link latencies, the closest unsettled site can never be reached faster later, so settling it is final.",
    pseudo: ["dist[v] ← ∞; dist[s] ← 0", "Q ← {s}", "while Q is not empty:", "  u ← extract-min(Q)   (u is now settled)", "  for each link (u, v, w):", "    if dist[u] + w < dist[v]:", "      dist[v] ← dist[u] + w", "      parent[v] ← u; decrease-key(Q, v)"] },
  { k: "bellman_ford", name: "Bellman-Ford", tag: "costs with rebates", heap: false, source: true, cx: "O(V·E), stops early when a round changes nothing",
    what: "Finds the cheapest $/GB route for data transfers, where some peering links pay a rebate (negative cost). Dijkstra would give wrong answers here.",
    why: "After round i every route using at most i links is correct; V−1 rounds cover every simple route. A change in round V would reveal a negative cycle.",
    pseudo: ["dist[v] ← ∞; dist[s] ← 0", "repeat V − 1 times:", "  for each arc (u, v, w):", "    if dist[u] + w < dist[v]:", "      dist[v] ← dist[u] + w", "      parent[v] ← u", "if any arc still improves: negative cycle"] },
  { k: "floyd_warshall", name: "Floyd–Warshall", tag: "all pairs", heap: false, source: false, cx: "Θ(V³) time, Θ(V²) memory",
    what: "Computes the fastest route between every pair of sites at once, the latency matrix the placement solver uses.",
    why: "Dynamic programming over intermediate sites: the best i→j route using sites 0..k either avoids k or goes through it once.",
    pseudo: ["d[i][j] ← w(i, j); d[i][i] ← 0", "for k in V:", "  for i in V:", "    for j in V:", "      d[i][j] ← min(d[i][j], d[i][k] + d[k][j])"] },
  { k: "johnson", name: "Johnson", tag: "all pairs with rebates", heap: true, source: false, cx: "O(V·E + V(V+E) log V): faster than Floyd–Warshall on sparse networks",
    what: "All-pairs cheapest transfer costs when some links are negative: reweights the links so Dijkstra becomes safe, then runs it from every site.",
    why: "Potentials h from Bellman-Ford make every weight non-negative, and every route between the same two sites changes by the same amount h(s) − h(t).",
    pseudo: ["add vertex q with 0-cost arcs to every vertex", "h ← Bellman-Ford(q)", "w'(u, v) ← w(u, v) + h(u) − h(v)   (now ≥ 0)", "for each source s: Dijkstra(s) using w'", "d(s, t) ← d'(s, t) − h(s) + h(t)"] },
];
const LINE: Record<string, Record<string, number>> = {
  prim: { visit: 3, add_edge: 3, consider: 5, relax: 6 }, kruskal: { add_edge: 4, reject_cycle: 6 },
  dijkstra: { settle: 3, relax: 6 }, bellman_ford: { relax: 4 },
};

export default function Lab() {
  const { mode, region } = useApp();
  const live = mode === "live";
  const list = useAsync(() => getDatasets(), []);
  const [ds, setDs] = useState<string>(region);
  const [alg, setAlg] = useState<Alg>("dijkstra");
  const [src, setSrc] = useState(0);
  const [heap, setHeap] = useState("binary");
  const [inst, setInst] = useState<Instance | null>(null);
  const [res, setRes] = useState<AlgoResult & { _snapshot?: boolean; _key?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [dst, setDst] = useState(1);
  const [tab, setTab] = useState<"watch" | "compare">("watch");
  const [fullRun, setFullRun] = useState(false);
  const [bfRes, setBfRes] = useState<AlgoResult | null>(null);
  const A = ALGS.find((a) => a.k === alg)!;
  const N = inst?.graph.nodes ?? [];
  const srcOk = live || N.length <= 30;          // offline: saved runs exist for every start city on small networks
  const usesSrc = alg === "dijkstra" || alg === "bellman_ford" || alg === "prim";
  const srcEff = usesSrc && srcOk ? src : 0;

  useEffect(() => { getDataset(ds).then((d) => { setInst(d); setSrc(0); setDst(farthest(d, 0)); }).catch((e) => setErr(String(e.message ?? e))); }, [ds]);
  useEffect(() => {
    let alive = true; setErr(null); setRes(null); setPlaying(false); setStep(0); setFullRun(false);
    runAlgorithm({ dataset: ds, algorithm: alg, source: srcEff, heap: live ? heap : "binary" })
      .then((r) => { if (alive) { setRes({ ...r, _key: `${ds}|${alg}|${srcEff}` }); setStep(0); setPlaying(!!r.trace?.length); } })
      .catch((e) => alive && setErr(String(e.message ?? e)));
    return () => { alive = false; };
  }, [ds, alg, srcEff, heap, live]);
  useEffect(() => { // Johnson's matrix has no parents: take the cheapest route from a Bellman-Ford run on the same costs
    setBfRes(null); if (alg !== "johnson" || !srcOk) return; let alive = true;
    runAlgorithm({ dataset: ds, algorithm: "bellman_ford", source: src, heap: "binary" }).then((r) => alive && setBfRes(r)).catch(() => {});
    return () => { alive = false; };
  }, [ds, alg, src, srcOk]);
  useEffect(() => { setFullRun(false); }, [dst]);

  const fresh = res?._key === `${ds}|${alg}|${srcEff}` ? res : null; // never replay another algorithm's trace
  const fullTrace = fresh?.trace ?? [];
  const src0 = usesSrc ? (fresh?.source ?? srcEff) : (srcOk ? src : 0);
  const target = dst !== src0 && dst < N.length ? dst : -1;
  const stopAt = !fullRun && fresh && target >= 0 ? answerStep(alg, fresh, src0, target, N.length) : null;
  const trace = stopAt != null ? fullTrace.slice(0, stopAt) : fullTrace;
  const sps = Math.max(4, fullTrace.length / 18) * speed;
  const timer = useRef(0);
  useEffect(() => {
    if (!playing) return;
    const t0 = performance.now(), s0 = step;
    const tick = (t: number) => { const s = Math.min(trace.length, s0 + Math.floor(((t - t0) / 1000) * sps)); setStep(s); if (s >= trace.length) { setPlaying(false); return; } timer.current = requestAnimationFrame(tick); };
    timer.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(timer.current);
  }, [playing, sps]); // eslint-disable-line react-hooks/exhaustive-deps

  const nm = (i: number) => shortName(N[i]?.name ?? String(i));
  const unit = alg === "bellman_ford" ? "$/GB" : "ms";
  const fmtD = (d: number) => (alg === "bellman_ford" ? d.toFixed(3) : d.toFixed(2));

  /* replay the trace up to `step` */
  const view = useMemo(() => {
    const nodeMark: Record<number, any> = {}, edgeMark: Record<string, EdgeMark> = {}, badges: Record<number, string> = {};
    let ev: any = null, relax = 0, weight = 0, round = 0;
    const res = fresh;
    if (!res || !trace.length) return { nodeMark, edgeMark, badges, ev, relax, weight, round };
    const dist: Record<number, number> = {}; const parent: Record<number, number> = {};
    if (alg === "dijkstra" || alg === "bellman_ford" || alg === "prim") { nodeMark[res.source ?? src] = "source"; }
    if (alg === "dijkstra" || alg === "bellman_ford") { dist[res.source ?? 0] = 0; }
    for (let k = 0; k < step; k++) {
      const e = trace[k]; ev = e;
      if (alg === "prim") {
        if (e.type === "visit") nodeMark[e.u] = "settled";
        if (e.type === "add_edge") { edgeMark[ekey(e.u, e.v)] = "tree"; nodeMark[e.v] = "settled"; weight += e.w; }
        if (e.type === "relax") { relax++; if (nodeMark[e.v] !== "settled") nodeMark[e.v] = "frontier"; badges[e.v] = e.w.toFixed(2); }
      } else if (alg === "kruskal") {
        if (e.type === "add_edge") { edgeMark[ekey(e.u, e.v)] = "tree"; weight += e.w; nodeMark[e.u] = nodeMark[e.v] = "settled"; }
        if (e.type === "reject_cycle") edgeMark[ekey(e.u, e.v)] = edgeMark[ekey(e.u, e.v)] ?? "reject";
      } else if (alg === "dijkstra") {
        if (e.type === "settle") { nodeMark[e.u] = "settled"; if (parent[e.u] != null) edgeMark[ekey(parent[e.u], e.u)] = "tree"; }
        if (e.type === "relax") { relax++; dist[e.v] = e.d; parent[e.v] = e.u; if (nodeMark[e.v] !== "settled") nodeMark[e.v] = "frontier"; }
      } else if (alg === "bellman_ford") {
        if (e.type === "relax") { relax++; if (parent[e.v] != null) delete edgeMark[ekey(parent[e.v], e.v)]; dist[e.v] = e.d; parent[e.v] = e.u; round = e.round + 1; nodeMark[e.v] = "frontier"; }
      }
    }
    if (alg === "bellman_ford") Object.entries(parent).forEach(([v, u]) => (edgeMark[ekey(+u, +v)] = "tree"));
    if (alg === "dijkstra" || alg === "bellman_ford") Object.entries(dist).forEach(([v, d]) => (badges[+v] = fmtD(d)));
    if (ev && step < trace.length + 1) {
      if (ev.type === "consider" || ev.type === "relax") { edgeMark[ekey(ev.u, ev.v)] = ev.type === "relax" ? "relax" : "consider"; }
      if (ev.type === "reject_cycle") edgeMark[ekey(ev.u, ev.v)] = "reject";
      const cur = ev.type === "settle" || ev.type === "visit" ? ev.u : ev.v; if (cur != null) nodeMark[cur] = "current";
    }
    if (nodeMark[res.source ?? -1] && (alg === "dijkstra" || alg === "bellman_ford" || alg === "prim") && ev?.u !== res.source) nodeMark[res.source!] = "source";
    return { nodeMark, edgeMark, badges, ev, relax, weight, round };
  }, [fresh, step, alg]); // eslint-disable-line react-hooks/exhaustive-deps

  /* the final start → destination route for this algorithm */
  const route = useMemo(() => {
    if (!fresh || !inst || target < 0) return null;
    let path: number[] = []; let cost: number | null = null;
    if (alg === "dijkstra" || alg === "bellman_ford") path = fromParent(fresh.parent, src0, target);
    else if (alg === "prim" || alg === "kruskal") path = treePath(fresh.edges, N.length, src0, target);
    else if (alg === "floyd_warshall") path = fastestPath(inst, src0, target);
    else if (alg === "johnson") path = bfRes ? fromParent(bfRes.parent, src0, target) : [];
    if (alg === "bellman_ford") cost = (fresh.dist as number[])[target];
    if (alg === "johnson") cost = (fresh.dist as number[][])[src0]?.[target] ?? null;
    if (!path.length) return null;
    return { path, lat: pathLatency(inst, path), cost, best: pathLatency(inst, fastestPath(inst, src0, target)) };
  }, [fresh, inst, alg, src0, target, bfRes]); // eslint-disable-line react-hooks/exhaustive-deps

  const sentence = (() => {
    const e = view.ev;
    if (!e && fresh && !trace.length && (alg === "floyd_warshall" || alg === "johnson")) return <><b>Done in {fmt(fresh.runtime_ms, 2)} ms.</b> All {N.length * N.length} pairs computed at once. Hover a cell for the exact value; for these networks the automatic rule would choose <b>{(fresh.auto_choice ?? "").replace(/_/g, " ").replace("numpy", "(NumPy)")}</b>.</>;
    if (!e) return step === 0 && trace.length ? "Press play, or step through one event at a time." : "";
    switch (e.type) {
      case "visit": return <>Start the tree at <b>{nm(e.u)}</b>.</>;
      case "consider": return <>Look at link <b>{nm(e.u)} – {nm(e.v)}</b> ({fmtD(e.w)} ms).</>;
      case "relax": return alg === "prim" ? <><b>{nm(e.v)}</b> can now join for {fmtD(e.w)} ms via {nm(e.u)}.</> : <>Found a better route to <b>{nm(e.v)}</b> through {nm(e.u)}: <b>{fmtD(e.d)} {unit}</b>{alg === "bellman_ford" ? ` (round ${e.round + 1})` : ""}.</>;
      case "add_edge": return <>Added <b>{nm(e.u)} – {nm(e.v)}</b> ({fmtD(e.w)} ms) to the tree.</>;
      case "reject_cycle": return <>Skipped <b>{nm(e.u)} – {nm(e.v)}</b>: both ends are already connected, so it would close a loop.</>;
      case "settle": return <><b>{nm(e.u)}</b> is settled at <b>{fmtD(e.d)} ms</b>; no faster route to it can exist.</>;
    }
    return null;
  })();
  const line = view.ev ? LINE[alg]?.[view.ev.type] : undefined;
  const done = trace.length > 0 && step >= trace.length;
  const showRoute = !!route && (done || !fullTrace.length);
  const marks = useMemo(() => {
    const nodeMark = { ...view.nodeMark }, edgeMark = { ...view.edgeMark };
    if (target >= 0) nodeMark[target] = nodeMark[target] === "current" ? "current" : "target";
    if (showRoute) { route!.path.slice(1).forEach((v, i) => (edgeMark[ekey(route!.path[i], v)] = "path")); nodeMark[target] = "target"; nodeMark[src0] = "source"; }
    return { nodeMark, edgeMark };
  }, [view, target, showRoute, route, src0]);
  const snapshot = !!res?._snapshot;
  const avail = (list.data ?? []).filter((d) => live || ["abilene", "nsfnet", "india", "nigeria", "woxsen", "fat-tree-k4", "waxman-60", "waxman-60-tight"].includes(d.name));

  return (
    <main className="labpage">
      <aside className="card lab-ctl">
        <div className="ttl-row"><div className="ttl">Algorithm lab</div>
          <Info title="Algorithm lab">Pick an algorithm and a network, then press play to watch it run one step at a time. The highlighted line of pseudocode shows what the algorithm is doing at each moment.</Info></div>
        <div className="field"><div className="lab">Algorithm</div>
          <div className="algos">{ALGS.map((a) => <button key={a.k} aria-pressed={alg === a.k} onClick={() => setAlg(a.k)}>{a.name}<small>{a.tag}</small></button>)}</div></div>
        <div className="field"><label className="lab" htmlFor="lab-ds">Network</label>
          <select id="lab-ds" value={ds} onChange={(e) => { setDs(e.target.value); setSrc(0); }}>{avail.map((d) => <option key={d.name} value={d.name}>{d.name} ({d.nodes} nodes)</option>)}</select></div>
        <div className="field two"><div><label className="lab" htmlFor="lab-src">{alg === "prim" ? "Start the tree at" : "Start city"}</label>
          <select id="lab-src" value={srcOk ? src : 0} disabled={!srcOk} onChange={(e) => { const v = +e.target.value; setSrc(v); if (v === dst) setDst(v === 0 ? 1 : 0); }}>{N.map((n, i) => <option key={i} value={i}>{shortName(n.name)}</option>)}</select></div>
          <div><label className="lab" htmlFor="lab-dst">Destination</label>
          <select id="lab-dst" value={dst} onChange={(e) => setDst(+e.target.value)}>{N.map((n, i) => <option key={i} value={i} disabled={i === (srcOk ? src : 0)}>{shortName(n.name)}</option>)}</select></div></div>
        {A.heap && <div className="field"><label className="lab" htmlFor="lab-heap">Priority queue</label>
          <select id="lab-heap" value={heap} disabled={!live} onChange={(e) => setHeap(e.target.value)}>
            <option value="binary">Binary heap</option><option value="fibonacci">Fibonacci heap</option><option value="pairing">Pairing heap</option><option value="lazy">heapq with lazy deletion</option></select></div>}
        {!live && mode && <p className="mini-note">{srcOk ? "Saved runs use a binary heap." : "On this network saved runs start from the first city."} Start the Python API to choose any heap or network.</p>}
        <div className="prose"><b>What it does.</b> {A.what}</div>
        <div className="prose"><b>Why it is correct.</b> {A.why}</div>
        <div className="prose"><b>Running time.</b> {A.cx}</div>
      </aside>

      <div className="lab-center" data-tour="lab">
        <div className="lab-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "watch"} onClick={() => setTab("watch")}>Watch it run</button>
          <button role="tab" aria-selected={tab === "compare"} onClick={() => setTab("compare")}>Compare two algorithms</button>
          <Info title="Watch or compare">Watch it run replays one algorithm step by step from the start city to the destination. Compare runs two algorithms on the same trip and tells you which one suits it best.</Info>
        </div>
        {tab === "compare" && inst ? <Compare ds={ds} inst={inst} src={srcOk ? src : 0} dst={target >= 0 ? target : dst} live={live} heap={live ? heap : "binary"} /> : <>
        <div className="lab-map">
          {err && <div className="banner err" style={{ margin: 16 }}>{err}</div>}
          {inst && fresh && (alg === "floyd_warshall" || alg === "johnson")
            ? <Heat res={fresh} names={N.map((n) => shortName(n.name))} unit={alg === "johnson" ? "$/GB" : "ms"} hi={target >= 0 ? [src0, target] : undefined} />
            : inst && fresh ? <NetworkMap nodes={N} links={inst.graph.links} variant="lab" nodeMark={marks.nodeMark} edgeMark={marks.edgeMark} badges={view.badges}
                extraArcs={alg === "bellman_ford" ? (fresh.negative_arcs ?? []).map(([u, v]) => ({ u, v, kind: "negative" as const })) : undefined}
                renderTip={(i) => <><h5>{N[i].name}</h5><div className="r"><span>Tier</span><b>{N[i].tier}</b></div>{view.badges[i] && <div className="r"><span>{alg === "prim" ? "Key" : "Distance"}</span><b>{view.badges[i]} {alg === "prim" ? "ms" : unit}</b></div>}</>} />
              : !err && <div className="loading" style={{ height: "100%" }}><div><div className="spin" />Running {A.name}</div></div>}
        </div>
        {trace.length > 0 && <div className="player" role="group" aria-label="Playback">
          <button className="pbtn" aria-label={playing ? "Pause" : "Play"} onClick={() => { if (done) setStep(0); setPlaying(!playing); }}>
            {playing ? <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
              : <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>}
          </button>
          <button className="sbtn" aria-label="Step back" onClick={() => { setPlaying(false); setStep(Math.max(0, step - 1)); }}><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" /></svg></button>
          <button className="sbtn" aria-label="Step forward" onClick={() => { setPlaying(false); setStep(Math.min(trace.length, step + 1)); }}><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" /></svg></button>
          <input type="range" min={0} max={trace.length} value={step} aria-label="Step" onChange={(e) => { setPlaying(false); setStep(+e.target.value); }} />
          <div className="speeds" role="group" aria-label="Playback speed">{[0.5, 1, 1.5, 2, 4].map((v) => <button key={v} aria-pressed={speed === v} onClick={() => setSpeed(v)}>{v}×</button>)}</div>
          <span className="cnt">{step} / {trace.length}</span>
        </div>}
        </>}
      </div>

      <aside className="card lab-side">
        {snapshot && <div className="banner">Saved run. Start the Python API for live runs.</div>}
        <div className="event" aria-live="polite">{done ? <><b>Finished.</b> {stopAt != null ? `The route to ${nm(target)} is final${alg === "dijkstra" ? `, ${fmtD((fresh?.dist as number[])?.[target] ?? 0)} ms away` : ""}.` : summary(alg, fresh, view, N.length)}</> : sentence}</div>
        {stopAt != null && done && stopAt < fullTrace.length && <div className="stopnote"><b>Stopped early.</b> {alg === "dijkstra" ? <>{nm(target)} was settled after {stopAt} of {fullTrace.length} events, so its route can no longer change. Dijkstra can stop here; Bellman-Ford cannot.</> : <>{nm(target)} joined the tree after {stopAt} of {fullTrace.length} events, and tree routes never change once built.</>}
          <button className="btn tonal sm" onClick={() => { setFullRun(true); setPlaying(true); }}>Run to the end</button></div>}
        {showRoute && <RouteCard path={route!.path} names={N.map((n) => shortName(n.name))} lat={route!.lat} best={route!.best} cost={route!.cost} alg={alg} />}
        <div><div className="h-sub"><span>Pseudocode</span></div>
          <div className="pseudo">{A.pseudo.map((l, k) => <div key={k} className={k === line ? "on" : ""}>{l}</div>)}</div></div>
        <div className="facts">
          <div><b>{fmt(res?.runtime_ms, 2)}</b><span>ms to run (Python)</span></div>
          <div><b>{trace.length || "–"}</b><span>{trace.length ? `events recorded${fresh?.trace_truncated ? " (first 6000)" : ""}` : "no step trace (matrix algorithm)"}</span></div>
          {alg === "floyd_warshall" || alg === "johnson"
            ? <div><b>{N.length * N.length}</b><span>pairs computed</span></div>
            : <div><b>{alg === "prim" || alg === "kruskal" ? view.weight.toFixed(2) : view.relax}</b><span>{alg === "prim" || alg === "kruskal" ? "tree weight so far (ms)" : "relaxations so far"}</span></div>}
          <div><b>{alg === "bellman_ford" ? view.round : fresh?.auto_choice ? fresh.auto_choice.replace(/_/g, " ").replace("numpy", "").trim() : N.length}</b><span>{alg === "bellman_ford" ? "current round" : fresh?.auto_choice ? "auto choice for this network" : "sites"}</span></div>
        </div>
        {(alg === "dijkstra" || alg === "bellman_ford" || alg === "prim" || alg === "kruskal") && <div className="prose"><b>Colours.</b> Green: in the tree or settled. Light blue: reached but not final. Yellow: what is happening now.{alg === "kruskal" && " Red dashed: skipped because it would close a loop."}{alg === "bellman_ford" && " Red arrows: rebate links with negative cost."}</div>}
      </aside>
    </main>
  );
}

function summary(alg: Alg, res: AlgoResult | null, v: any, n: number) {
  if (!res) return "";
  if (alg === "prim" || alg === "kruskal") return `The spanning tree uses ${n - (res.components ?? 1)} links with total latency ${fmt(res.total_weight, 2)} ms.`;
  if (alg === "dijkstra" || alg === "bellman_ford") {
    const d = (res.dist as (number | null)[]).filter((x): x is number => x != null);
    const far = Math.max(...d);
    return alg === "dijkstra" ? `Every site is settled. The farthest is ${far.toFixed(2)} ms away; the green links form the shortest-path tree.` : `No further improvement, so no negative cycle. The most expensive destination costs $${far.toFixed(3)}/GB.`;
  }
  return "";
}

const farthest = (d: Instance, s: number) => {
  // a city about two-thirds of the way out: far enough to be interesting, near enough that Dijkstra can stop early
  const ds: [number, number][] = [];
  for (let t = 0; t < d.graph.nodes.length; t++) { if (t === s || d.graph.nodes[t].tier === "router") continue; const p = fastestPath(d, s, t); if (p.length) ds.push([pathLatency(d, p), t]); }
  ds.sort((a, b) => a[0] - b[0]);
  return ds.length ? ds[Math.floor(ds.length * 0.66)][1] : (s === 0 ? 1 : 0);
};

const money = (c: number | null | undefined) => (c == null ? "—" : c < 0 ? `−$${Math.abs(c).toFixed(3)}` : `$${c.toFixed(3)}`);

function RouteCard({ path, names, lat, best, cost, alg }: { path: number[]; names: string[]; lat: number; best: number; cost: number | null; alg: Alg }) {
  const tree = alg === "prim" || alg === "kruskal";
  return (
    <div className="routecard">
      <div className="h-sub"><span>Route found</span></div>
      <div className="hops">{path.map((v, i) => <span key={i}>{i > 0 && <i>→</i>}<b className={i === 0 ? "s" : i === path.length - 1 ? "t" : ""}>{names[v]}</b></span>)}</div>
      <div className="rnums"><div><b>{lat.toFixed(2)} ms</b><span>delay</span></div><div><b>{path.length - 1}</b><span>hops</span></div>
        {cost != null && <div><b>{money(cost)}</b><span>{cost < 0 ? "per GB (net rebate)" : "per GB"}</span></div>}</div>
      {tree && lat > best + 1e-6 && <p className="mini-note">Going only along the tree takes {(lat / best).toFixed(2)}× the fastest route ({best.toFixed(2)} ms). A spanning tree is the cheapest way to connect everything, not the fastest way between two cities.</p>}
      {cost != null && lat > best + 1e-6 && <p className="mini-note">The cheapest route is not the fastest: the fastest takes {best.toFixed(2)} ms but costs more per GB.</p>}
    </div>
  );
}

const GOAL: Record<Alg, "lat" | "cost" | "tree"> = { dijkstra: "lat", floyd_warshall: "lat", bellman_ford: "cost", johnson: "cost", prim: "tree", kruskal: "tree" };
const GOAL_TXT = { lat: "Fastest route (delay in ms)", cost: "Cheapest transfer ($/GB, rebates allowed)", tree: "Cheapest backbone tree" };

function Compare({ ds, inst, src, dst, live, heap }: { ds: string; inst: Instance; src: number; dst: number; live: boolean; heap: string }) {
  const [a, setA] = useState<Alg>("dijkstra");
  const [b, setB] = useState<Alg>("bellman_ford");
  const [out, setOut] = useState<Record<string, AlgoResult>>({});
  const [err, setErr] = useState<string | null>(null);
  const N = inst.graph.nodes; const n = N.length; const m = inst.graph.links.length;
  useEffect(() => {
    let alive = true; setOut({}); setErr(null);
    const need = new Set<Alg>([a, b]); if (a === "johnson" || b === "johnson") need.add("bellman_ford");
    Promise.all([...need].map((k) => runAlgorithm({ dataset: ds, algorithm: k, source: k === "dijkstra" || k === "bellman_ford" || k === "prim" ? src : 0, heap }).then((r) => [k, r] as const)))
      .then((rs) => alive && setOut(Object.fromEntries(rs)))
      .catch((e) => alive && setErr(String(e.message ?? e)));
    return () => { alive = false; };
  }, [ds, a, b, src, heap, live]);

  const stat = (k: Alg) => {
    const r = out[k]; if (!r) return null;
    let path: number[] = []; let cost: number | null = null;
    if (k === "dijkstra" || k === "bellman_ford") path = fromParent(r.parent, src, dst);
    else if (k === "prim" || k === "kruskal") path = treePath(r.edges, n, src, dst);
    else if (k === "floyd_warshall") path = fastestPath(inst, src, dst);
    else path = out.bellman_ford ? fromParent(out.bellman_ford.parent, src, dst) : [];
    if (k === "bellman_ford") cost = (r.dist as number[])[dst];
    if (k === "johnson") cost = (r.dist as number[][])[src]?.[dst] ?? null;
    const early = answerStep(k, r, src, dst, n);
    const work = k === "floyd_warshall" ? n * n * n : k === "johnson" ? Math.round(n * m * 2 + n * (n + 2 * m) * Math.log2(n)) : early ?? (r.trace?.length ?? 0);
    const workTxt = k === "floyd_warshall" ? `${work.toLocaleString()} updates (all ${n * n} pairs)` : k === "johnson" ? `≈${work.toLocaleString()} operations (all pairs)` : early != null ? `${early} of ${r.trace?.length} steps (stops early)` : `${r.trace?.length ?? 0} steps (must finish)`;
    return { path, lat: path.length ? pathLatency(inst, path) : NaN, cost, work, workTxt, ms: r.runtime_ms };
  };
  const sa = stat(a), sb = stat(b);
  const name = (k: Alg) => ALGS.find((x) => x.k === k)!.name;
  const verdict = (() => {
    if (!sa || !sb) return null;
    if (a === b) return <>Pick two different algorithms to compare.</>;
    const ga = GOAL[a], gb = GOAL[b];
    if (ga === gb) {
      if (ga === "tree") { const prim = m > n * Math.log2(n); return <><b>Best here: {prim ? "Prim" : "Kruskal"}.</b> Both build the same cheapest tree, so the route is identical. This network has {m} links for {n} sites; {prim ? "that is dense, so Prim's single pass with a heap beats sorting every link" : "that is sparse, so sorting the few links (Kruskal) is quicker than Prim's heap work"}.</>; }
      const single = ga === "lat" ? "dijkstra" : "bellman_ford"; const all = ga === "lat" ? "Floyd–Warshall" : "Johnson";
      return <><b>Best for this trip: {name(single as Alg)}.</b> Both find the same {ga === "lat" ? "fastest" : "cheapest"} route, but {name(single as Alg)} only works out routes from {shortName(N[src].name)}{single === "dijkstra" ? " and stops once the destination is settled" : ""}, while {all} computes all {n * n} pairs. Use {all} when you need every pair at once, as the placement solver does.</>;
    }
    const pick = (g: string) => (GOAL[a] === g ? a : GOAL[b] === g ? b : null);
    const L = pick("lat"), C = pick("cost"), T = pick("tree");
    if (L && T) { const sl = L === a ? sa : sb, st = T === a ? sa : sb; return <><b>Best for this trip: {name(L)}.</b> It finds the fastest route ({sl.lat.toFixed(2)} ms). {name(T)} builds the cheapest network to connect every site, and travelling only along that tree takes {st.lat.toFixed(2)} ms ({(st.lat / sl.lat).toFixed(2)}×). Use {name(T)} to design the backbone, {name(L)} to route traffic.</>; }
    if (L && C) { const sl = L === a ? sa : sb, sc = C === a ? sa : sb; return <><b>It depends on what you are optimising.</b> For speed use <b>{name(L)}</b>: {sl.lat.toFixed(2)} ms. For the transfer bill use <b>{name(C)}</b>: {money(sc.cost)}/GB{sc.lat > sl.lat + 1e-6 ? `, via a route that is slower (${sc.lat.toFixed(2)} ms)` : ", and here it is also the fastest route"}. Some links pay a rebate (negative cost), which {name(L)} cannot handle correctly, so cost routing needs {name(C)}.</>; }
    if (C && T) { const sc = C === a ? sa : sb; return <><b>Best for this trip: {name(C)}.</b> It finds the cheapest transfer ({money(sc.cost)}/GB). {name(T)} answers a different question: the cheapest set of links that connects every site.</>; }
    return null;
  })();
  const row = (label: string, fa: (s: NonNullable<typeof sa>) => ReactNode) => <tr><th>{label}</th><td>{sa ? fa(sa) : "…"}</td><td>{sb ? fa(sb) : "…"}</td></tr>;
  const mapFor = (s: ReturnType<typeof stat>) => {
    const edgeMark: Record<string, EdgeMark> = {}; const nodeMark: Record<number, any> = { [src]: "source", [dst]: "target" };
    s?.path.slice(1).forEach((v, i) => (edgeMark[ekey(s.path[i], v)] = "path"));
    return <NetworkMap nodes={N} links={inst.graph.links} variant="lab" nodeMark={nodeMark} edgeMark={edgeMark} />;
  };
  const opts = ALGS.map((x) => <option key={x.k} value={x.k}>{x.name}</option>);
  return (
    <div className="compare">
      <div className="cmp-head">
        <select aria-label="First algorithm" value={a} onChange={(e) => setA(e.target.value as Alg)}>{opts}</select>
        <span className="vs">vs</span>
        <select aria-label="Second algorithm" value={b} onChange={(e) => setB(e.target.value as Alg)}>{opts}</select>
        <span className="trip">{shortName(N[src]?.name ?? "")} → {shortName(N[dst]?.name ?? "")}</span>
      </div>
      {err && <div className="banner err">{err}</div>}
      <div className="cmp-maps"><div><div className="cap a">{name(a)}</div>{mapFor(sa)}</div><div><div className="cap b">{name(b)}</div>{mapFor(sb)}</div></div>
      {verdict && <div className="verdict">{verdict}</div>}
      <table className="cmp-table"><thead><tr><th /><th>{name(a)}</th><th>{name(b)}</th></tr></thead><tbody>
        <tr><th>Optimises</th><td>{GOAL_TXT[GOAL[a]]}</td><td>{GOAL_TXT[GOAL[b]]}</td></tr>
        {row("Route", (s) => s.path.length ? s.path.map((v) => shortName(N[v].name)).join(" → ") : "—")}
        {row("Delay", (s) => isNaN(s.lat) ? "—" : `${s.lat.toFixed(2)} ms`)}
        {row("Hops", (s) => s.path.length ? s.path.length - 1 : "—")}
        {row("Transfer cost", (s) => s.cost != null ? `${money(s.cost)}/GB` : "not computed")}
        {row("Work to answer", (s) => s.workTxt)}
        {row("Run time (Python)", (s) => `${fmt(s.ms, 2)} ms`)}
        <tr><th>Running time</th><td>{ALGS.find((x) => x.k === a)!.cx}</td><td>{ALGS.find((x) => x.k === b)!.cx}</td></tr>
      </tbody></table>
    </div>
  );
}

function Heat({ res, names, unit, hi: pick }: { res: AlgoResult; names: string[]; unit: string; hi?: [number, number] }) {
  const D = (res.dist as (number | null)[][]) ?? [];
  const vals = D.flat().filter((x): x is number => x != null);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const ramp = ["#E8F0FE", "#C6DAFC", "#A1C2FA", "#7BAAF7", "#5592F0", "#2A78D6", "#1C5CAB", "#104281"];
  const col = (x: number) => ramp[Math.min(ramp.length - 1, Math.floor(((x - lo) / (hi - lo || 1)) * ramp.length))];
  const n = D.length; const showNums = n <= 26;
  return (
    <div className="heat">
      <p className="mini-note" style={{ margin: "4px 6px 8px", fontSize: 13 }}>{unit === "ms" ? "Fastest-route latency (ms) between every pair of sites." : "Cheapest transfer cost ($/GB) between every pair, rebates included."} Darker means farther. Rows are sources, columns are destinations.{res.meta?.potentials ? " Johnson's potentials made every link non-negative before running Dijkstra from each site." : ""}</p>
      <table><thead><tr><th />{names.map((nm, j) => <th key={j} title={nm}>{showNums ? nm.slice(0, 4) : ""}</th>)}</tr></thead>
        <tbody>{D.map((row, i) => <tr key={i}><th className="rh">{names[i]}</th>{row.map((x, j) => (
          <td key={j} className={pick && pick[0] === i && pick[1] === j ? "hi" : undefined} title={`${names[i]} → ${names[j]}: ${x == null ? "unreachable" : x.toFixed(3) + " " + unit}`} style={{ background: x == null ? "#fff" : col(x), color: x != null && (x - lo) / (hi - lo || 1) > 0.55 ? "#fff" : "#202124" }}>
            {showNums && x != null ? (unit === "ms" ? x.toFixed(1) : x.toFixed(2)) : ""}</td>))}</tr>)}</tbody></table>
    </div>
  );
}
