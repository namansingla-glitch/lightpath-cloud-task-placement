import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import NetworkMap, { MiniGraph } from "../components/NetworkMap";
import { CountUp, Glitch, ScrollVelocity, SplitText, TextCursorZone } from "../components/effects";
import { getDataset, getDatasets, solve } from "../lib/api";
import { useApp, useAsync } from "../lib/app";

const STAGES = [
  ["Latency matrix", "Floyd–Warshall or Johnson", "Θ(V³) · O(VE log V)"],
  ["Backbone", "Prim or Kruskal MST", "O(E log V)"],
  ["Routing", "Dijkstra, Bellman-Ford", "O(E log V) · O(VE)"],
  ["Server activation", "0/1 knapsack DP", "Θ(nW)"],
  ["Replica sizing", "Multiple-choice knapsack", "Θ(W·Σk)"],
  ["Placement", "Greedy schedulers", "O(Σk·S·C)"],
  ["Refinement", "Relocate and swap search", "local optimum"],
];
const ALGOS = ["Dijkstra", "Prim", "Kruskal", "Bellman-Ford", "Floyd–Warshall", "Johnson", "Knapsack DP", "Local search"];

export default function Home() {
  const { region, setRegion } = useApp();
  const nav = useNavigate();
  const ds = region;
  const inst = useAsync(() => getDataset(ds), [ds]);
  const sol = useAsync(() => solve({ dataset: ds }), [ds]);
  const list = useAsync(() => getDatasets(), []);

  const best = sol.data?.strategies.find((s) => s.name === sol.data!.best);
  const rnd = sol.data?.strategies.find((s) => s.name === "random");
  const hosts = useMemo(() => {
    const h: Record<number, number[]> = {};
    if (best) Object.entries(best.replicas).forEach(([j, arr]) => arr.forEach((s) => (h[s] ||= []).push(+j)));
    return h;
  }, [best]);
  const rows = useMemo(() => {
    const rts = (sol.data?.policy.routes ?? []).filter((r) => r.path.length > 2).slice(0, 10).map((r) => `${r.client_name} to ${r.replica_name} ${r.latency_ms.toFixed(1)} ms`);
    return [ALGOS, rts.length ? rts : ["Shortest paths", "Spanning trees", "Knapsack DP"]];
  }, [sol.data]);
  const words = useMemo(() => (sol.data?.policy.routes ?? []).filter((r) => r.latency_ms > 0).map((r) => r.latency_ms.toFixed(1) + " ms").concat(["O(E log V)", "Θ(V³)", "Θ(nW)", "α(n)"]), [sol.data]);

  return (
    <main>
      <div className="hero">
        <div>
          <div className="region" role="radiogroup" aria-label="Region" data-tour="region">
            {(["india", "nigeria"] as const).map((r) => (
              <button key={r} role="radio" aria-checked={region === r} onClick={() => setRegion(r)}>{r === "india" ? "India" : "Nigeria"}</button>
            ))}
          </div>
          <span className="chip-k"><span className="dots"><i style={{ background: "var(--blue)" }} /><i style={{ background: "var(--red)" }} /><i style={{ background: "var(--yellow)" }} /><i style={{ background: "var(--green)" }} /></span>Cloud task placement on network graphs</span>
          <SplitText className="display" text="Put every workload one short path from its users." />
          <p className="lede">Servers are nodes and fibre links are weighted edges. Lightpath combines shortest paths, spanning trees and knapsack dynamic programming to decide where each replica runs, without breaking capacity or budget.</p>
          <div className="ctas">
            <button className="btn primary" onClick={() => nav(`/studio?ds=${ds}`)}>Open the placement studio</button>
            <button className="btn tonal" onClick={() => nav("/lab")}>Step through the algorithms</button>
          </div>
        </div>
        <div className="mapcard" data-tour="heromap">
          <div className="mapbar"><span className="pill"><i style={{ background: "var(--yellow)", boxShadow: "0 0 0 1.5px #B06000 inset" }} />Hosts replicas</span><span className="pill"><i style={{ background: "var(--blue)" }} />Live request routes</span></div>
          {inst.data && sol.data && inst.data.name === ds && sol.data.instance?.name === ds
            ? <NetworkMap nodes={inst.data.graph.nodes} links={inst.data.graph.links} variant="hero" hosts={hosts} routes={sol.data.policy.routes} interactive={false} pad={70} />
            : <div className="loading"><div><div className="spin" />Loading the {region === "india" ? "India" : "Nigeria"} network</div></div>}
          <p className="cap">{inst.data?.description}. Each moving dot is a request on its computed shortest path to the nearest replica.</p>
        </div>
      </div>

      <div className="tiles" data-tour="tiles">
        {best && rnd ? <>
          <div><b><CountUp to={best.mean_ms ?? 0} decimals={2} delay={300} trigger={ds} /><small>ms</small></b><span>average user latency across {inst.data?.services.length ?? 0} services</span></div>
          <div><b><CountUp to={100 * (1 - (best.mean_ms ?? 0) / (rnd.mean_ms || 1))} decimals={1} delay={420} trigger={ds} /><small>%</small></b><span>lower than a random placement</span></div>
          <div><b><CountUp to={best.gap_pct ?? 0} decimals={1} delay={540} trigger={ds} /><small>%</small></b><span>{sol.data?.exact.objective != null ? "from the proven optimum (MILP)" : "optimality gap (not checked)"}</span></div>
          <div><b><CountUp to={best.runtime_ms ?? 0} decimals={1} delay={660} trigger={ds} /><small>ms</small></b><span>to compute the plan</span></div>
        </> : [0, 1, 2, 3].map((k) => <div key={k}><b>–</b><span>&nbsp;</span></div>)}
      </div>

      <ScrollVelocity rows={rows} />

      <TextCursorZone className="block" words={words}>
        <h2 className="title">From a graph to a placement plan</h2>
        <p className="intro">Seven stages, each a classic algorithm chosen for what it guarantees. The line runs left to right exactly as the solver does.</p>
        <div className="metro"><div className="metro-inner"><div className="metro-line" />
          {STAGES.map((s, i) => <div key={i} className="station"><div className="no">{i + 1}</div><div className="dot" /><h3>{s[0]}</h3><div className="alg">{s[1]}</div><div className="cx">{s[2]}</div></div>)}
        </div></div>
        <div className="branch"><strong>Exact check.</strong> On graphs small enough, a mixed-integer program solves placement to proven optimality, so every heuristic reports its gap.</div>
      </TextCursorZone>

      <section className="block" style={{ paddingTop: 24 }}>
        <h2 className="title">Ten networks to test on</h2>
        <p className="intro">Two real research backbones, real Indian and Nigerian city coordinates, the Woxsen University campus, a data-centre fat-tree and three random graph families at different sizes and densities.</p>
        <div className="ds-grid">
          {(list.data ?? []).map((d: any) => (
            <button key={d.name} className="ds" onClick={() => nav(`/studio?ds=${d.name}`)}>
              {d.preview && <MiniGraph nodes={d.preview.n} edges={d.preview.e} />}
              <h4>{d.name}</h4><p>{d.description}</p>
              <div className="meta"><span className="num">{d.nodes} nodes, {d.links} links</span><span>best <b className="num">{d.best_mean_ms} ms</b></span></div>
            </button>
          ))}
        </div>
      </section>
      <div className="bigmark"><Glitch text="Lightpath" />
        <p>Latency-aware cloud task placement. Graph algorithms, dynamic programming and greedy scheduling.</p></div>
      <footer>
        <div className="credits"><span>Built by <b>Naman Singla</b> and <b>Mohak Gupta</b></span><span>Guided by <b>Dr. Monday Jubrin Abdullahi</b></span></div>
        <div style={{ marginTop: 6 }}>Lightpath. Python (NumPy, SciPy HiGHS) engine with a FastAPI service, React dashboard.</div>
      </footer>
    </main>
  );
}
