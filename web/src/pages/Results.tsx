import { useMemo, useState, type ReactNode } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import { getExperiments, fileUrl } from "../lib/api";
import { SERVICE_PALETTE as C, prettyStrategy, useAsync } from "../lib/app";

type Row = Record<string, any>;
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/** rows → [{x, s1, s2, ...}] averaging repeated (x, series) cells */
function pivot(rows: Row[], xKey: string, sKey: string, vKey: string | ((r: Row) => number | null), series: string[]) {
  const xs = [...new Set(rows.map((r) => r[xKey]))].sort((a, b) => a - b);
  return xs.map((x) => {
    const o: Row = { x };
    series.forEach((s) => {
      const vals = rows.filter((r) => r[xKey] === x && r[sKey] === s).map((r) => (typeof vKey === "function" ? vKey(r) : r[vKey])).filter((v): v is number => v != null && isFinite(v));
      o[s] = vals.length ? +mean(vals).toFixed(4) : null;
    });
    return o;
  });
}

function Tip({ active, payload, label, xl, unit, names }: any) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tip"><b>{xl} {label}</b>{payload.filter((p: any) => p.value != null).map((p: any) => <div key={p.dataKey}><span style={{ color: p.color }}>● {names?.[p.dataKey] ?? p.dataKey}</span><span>{typeof p.value === "number" ? p.value.toFixed(p.value < 10 ? 3 : 1) : p.value} {unit}</span></div>)}</div>;
}

function Lines({ data, series, names, xl, yl, logX, logY, unit, dashed }: { data: Row[]; series: string[]; names?: Record<string, string>; xl: string; yl: string; logX?: boolean; logY?: boolean; unit: string; dashed?: string[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 18, left: 4 }}>
        <CartesianGrid stroke="#E8EAED" vertical={false} />
        <XAxis dataKey="x" type="number" scale={logX ? "log" : "linear"} domain={["dataMin", "dataMax"]} allowDataOverflow tick={{ fontSize: 11, fill: "#5F6368" }} tickLine={false} axisLine={{ stroke: "#DADCE0" }}
          label={{ value: xl, position: "insideBottom", offset: -10, fontSize: 12, fill: "#5F6368" }} ticks={logX ? data.map((d) => d.x) : undefined} />
        <YAxis scale={logY ? "log" : "linear"} domain={logY ? ["auto", "auto"] : [0, "auto"]} allowDataOverflow tick={{ fontSize: 11, fill: "#5F6368" }} tickLine={false} axisLine={false} width={52}
          label={{ value: yl, angle: -90, position: "insideLeft", offset: 12, fontSize: 12, fill: "#5F6368", style: { textAnchor: "middle" } }} />
        <Tooltip content={<Tip xl={xl} unit={unit} names={names} />} />
        {series.map((s, i) => <Line key={s} dataKey={s} stroke={C[i % C.length]} strokeWidth={2} dot={{ r: 3.5, strokeWidth: 0, fill: C[i % C.length] }} activeDot={{ r: 5 }} connectNulls isAnimationActive={false} strokeDasharray={dashed?.includes(s) ? "5 4" : undefined} />)}
      </LineChart>
    </ResponsiveContainer>
  );
}

function Legend({ series, names, dashed }: { series: string[]; names?: Record<string, string>; dashed?: string[] }) {
  return <div className="legend-row">{series.map((s, i) => <span key={s}><i style={{ background: dashed?.includes(s) ? `repeating-linear-gradient(90deg,${C[i % C.length]} 0 5px,transparent 5px 8px)` : C[i % C.length] }} />{names?.[s] ?? s}</span>)}</div>;
}

function Card({ title, q, children, take, csv, png, toggle }: { title: string; q: string; children: ReactNode; take: ReactNode; csv: string; png: string; toggle?: ReactNode }) {
  return (
    <article className="chart-card">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div><h3>{title}</h3><p className="q">{q}</p></div>{toggle}
      </div>
      {children}
      <p className="take">{take}</p>
      <div className="dl" style={{ marginTop: 10 }}><a href={fileUrl(`results/${csv}`)} download>Data (CSV)</a><a href={fileUrl(`figures/${png}`)} target="_blank" rel="noreferrer">Report figure (PNG)</a></div>
    </article>
  );
}
function Seg<T extends string>({ value, set, opts }: { value: T; set: (v: T) => void; opts: [T, string][] }) {
  return <div className="seg-inline">{opts.map(([k, l]) => <button key={k} aria-pressed={value === k} onClick={() => set(k)}>{l}</button>)}</div>;
}

export default function Results() {
  const ex = useAsync(() => getExperiments(), []);
  const [heapAlg, setHeapAlg] = useState<"dijkstra_ms" | "prim_ms">("dijkstra_ms");
  const [dens, setDens] = useState<"sparse" | "dense">("sparse");
  const [ls, setLs] = useState<"base" | "ls">("ls");
  const [capView, setCapView] = useState<"feas" | "gap">("feas");
  const R = ex.data?.results;

  const charts = useMemo(() => {
    if (!R) return null;
    const heaps = ["binary", "fibonacci", "pairing", "lazy"], heapNames = { binary: "Binary heap", fibonacci: "Fibonacci heap", pairing: "Pairing heap", lazy: "heapq (lazy)" };
    const h = pivot(R.sssp_heaps, "n", "heap", heapAlg, heaps);
    const fibRatio = mean(R.sssp_heaps.filter((r) => r.heap === "fibonacci").map((r) => r[heapAlg] / (R.sssp_heaps.find((b) => b.n === r.n && b.heap === "binary")?.[heapAlg] || 1)));
    const apAlgs = ["floyd_warshall", "floyd_warshall_numpy", "johnson", "repeated_dijkstra"], apNames = { floyd_warshall: "Floyd–Warshall (pure Python)", floyd_warshall_numpy: "Floyd–Warshall (NumPy)", johnson: "Johnson", repeated_dijkstra: "Dijkstra from every site" };
    const ap = pivot(R.apsp.filter((r) => r.density === dens && r.ms != null), "n", "algorithm", "ms", apAlgs);
    const choices = R.apsp.filter((r) => r.algorithm === "auto_choice" && r.density === dens).map((r) => r.choice);
    const mstS = ["prim_binary_ms", "prim_fibonacci_ms", "prim_lazy_ms", "kruskal_ms"], mstN = { prim_binary_ms: "Prim (binary)", prim_fibonacci_ms: "Prim (Fibonacci)", prim_lazy_ms: "Prim (heapq)", kruskal_ms: "Kruskal" };
    const mst = R.mst_density.map((r) => ({ x: r.m, ...Object.fromEntries(mstS.map((k) => [k, r[k]])) }));
    const strat = ["demand_first", "marginal_gain", "regret", "ffd_pack"];
    const qs = strat.map((s) => (ls === "ls" ? s + "+ls" : s));
    const qNames = Object.fromEntries(qs.map((s) => [s, prettyStrategy(s)]));
    const q = pivot(R.quality_size, "n", "strategy", "gap_pct", qs);
    const lsGap = mean(R.quality_size.filter((r) => r.strategy.endsWith("+ls") && r.gap_pct != null).map((r) => r.gap_pct));
    const baseGap = mean(R.quality_size.filter((r) => strat.includes(r.strategy) && r.gap_pct != null).map((r) => r.gap_pct));
    const rtS = [...strat.map((s) => s + "+ls"), "exact_milp"]; const rtN = Object.fromEntries(rtS.map((s) => [s, prettyStrategy(s)]));
    const rt = pivot(R.quality_size, "n", "strategy", "runtime_ms", rtS);
    const capS = capView === "feas" ? strat : strat.map((s) => s + "+ls"); const capN = Object.fromEntries(capS.map((s) => [s, prettyStrategy(s)]));
    const cap = capView === "feas" ? pivot(R.capacity, "capacity_factor", "strategy", (r) => (r.feasible ? 100 : 0), capS) : pivot(R.capacity, "capacity_factor", "strategy", "gap_pct", capS);
    const tight = R.capacity.filter((r) => r.capacity_factor <= 0.35);
    const feasRate = (s: string) => Math.round(100 * mean(tight.filter((r) => r.strategy === s).map((r) => (r.feasible ? 1 : 0))));
    const dS = ["random", "marginal_gain+ls", "regret+ls", "exact_milp"]; const dN = Object.fromEntries(dS.map((s) => [s, prettyStrategy(s)]));
    const dd = pivot(R.density, "p", "strategy", "mean_ms", dS);
    const bud = ["dp", "min"].map((sz) => R.budget.filter((r) => r.sizing === sz).map((r) => ({ x: r.spend, y: r.mean_ms, budget: r.budget, replicas: r.replicas })).sort((a, b) => a.x - b.x));
    const ks = R.knapsack.map((r) => ({ x: r.cells, y: Math.max(r.ms, 0.01), n: r.n, W: r.W }));
    return { h, heaps, heapNames, fibRatio, ap, apAlgs, apNames, choices, mst, mstS, mstN, q, qs, qNames, lsGap, baseGap, rt, rtS, rtN, cap, capS, capN, feasRate, dd, dS, dN, bud, ks };
  }, [R, heapAlg, dens, ls, capView]);

  return (
    <main className="page-pad">
      <div className="page-head"><div><h1>Results</h1>
        <p>Eight experiments on synthetic and real networks: how fast each algorithm runs and how good each placement is as networks grow, get denser, run short of capacity or get more budget. Hover any point for exact values.</p></div>
        {ex.data && <span className="chip-k">Generated {ex.data.generated}</span>}</div>
      {ex.error && <div className="banner err">Could not load the experiments: {ex.error}</div>}
      {!charts ? <div className="loading"><div><div className="spin" />Loading results</div></div> : (
        <div className="charts" data-tour="charts">
          <Card title="Priority queues" q="Which heap makes Dijkstra and Prim fastest in practice?" csv="sssp_heaps.csv" png="e1_heaps.png"
            toggle={<Seg value={heapAlg} set={setHeapAlg} opts={[["dijkstra_ms", "Dijkstra"], ["prim_ms", "Prim"]]} />}
            take={<>The Fibonacci heap has the best bound on paper but runs <b>{charts.fibRatio.toFixed(2)}×</b> the binary heap's time here: its pointer-heavy structure costs more in Python than it saves.</>}>
            <div className="plot"><Lines data={charts.h} series={charts.heaps} names={charts.heapNames} xl="sites (n)" yl="ms" logX logY unit="ms" /></div>
            <Legend series={charts.heaps} names={charts.heapNames} /></Card>

          <Card title="All-pairs shortest paths" q="Floyd–Warshall or Johnson: which wins, and when?" csv="apsp.csv" png="e2_apsp.png"
            toggle={<Seg value={dens} set={setDens} opts={[["sparse", "Sparse"], ["dense", "Dense"]]} />}
            take={<>On {dens} networks the automatic rule picked <b>{[...new Set(charts.choices.map((c: string) => c.replace(/\[.*\]/, "").replace(/_/g, " ")))].join(" and ")}</b>. Pure-Python Floyd–Warshall grows as V³; vectorising the same recurrence with NumPy makes it competitive on dense graphs.</>}>
            <div className="plot"><Lines data={charts.ap} series={charts.apAlgs} names={charts.apNames} xl="sites (n)" yl="ms" logX logY unit="ms" /></div>
            <Legend series={charts.apAlgs} names={charts.apNames} /></Card>

          <Card title="Spanning tree vs density" q="How do Prim and Kruskal scale as links are added?" csv="mst_density.csv" png="e3_mst.png"
            take={<>Kruskal's sort dominates on dense networks, while Prim with a heap touches each link once; both return the same total weight, as the cut property guarantees.</>}>
            <div className="plot"><Lines data={charts.mst} series={charts.mstS} names={charts.mstN} xl="links (m)" yl="ms" unit="ms" /></div>
            <Legend series={charts.mstS} names={charts.mstN} /></Card>

          <Card title="Solution quality vs size" q="How far are the fast methods from the proven optimum?" csv="quality_size.csv" png="e4_quality_size.png"
            toggle={<Seg value={ls} set={setLs} opts={[["base", "Greedy only"], ["ls", "With local search"]]} />}
            take={<>Greedy alone averages a <b>{charts.baseGap.toFixed(1)}%</b> gap; adding local search brings it to <b>{charts.lsGap.toFixed(2)}%</b>. The largest size is compared with the LP lower bound, because the exact MILP becomes too slow.</>}>
            <div className="plot"><Lines data={charts.q} series={charts.qs} names={charts.qNames} xl="sites (n)" yl="gap to optimum (%)" unit="%" /></div>
            <Legend series={charts.qs} names={charts.qNames} /></Card>

          <Card title="Solver runtime vs size" q="What does the exact answer cost compared with the heuristics?" csv="quality_size.csv" png="e4_quality_size.png"
            take={<>The exact MILP grows fastest and is skipped beyond a few thousand variables; greedy plus local search stays one to two orders of magnitude cheaper for near-identical quality.</>}>
            <div className="plot"><Lines data={charts.rt} series={charts.rtS} names={charts.rtN} xl="sites (n)" yl="ms" logY unit="ms" dashed={["exact_milp"]} /></div>
            <Legend series={charts.rtS} names={charts.rtN} dashed={["exact_milp"]} /></Card>

          <Card title="Capacity pressure" q="What happens when servers run short of CPU and memory?" csv="capacity.csv" png="e5_capacity.png"
            toggle={<Seg value={capView} set={setCapView} opts={[["feas", "Feasible runs"], ["gap", "Gap"]]} />}
            take={<>At 0.35× capacity or less, FFD packing finds a full placement in <b>{charts.feasRate("ffd_pack")}%</b> of runs versus <b>{charts.feasRate("marginal_gain")}%</b> for marginal gain: under tight capacity, packing first matters more than chasing latency.</>}>
            <div className="plot"><Lines data={charts.cap} series={charts.capS} names={charts.capN} xl="capacity factor (× nominal)" yl={capView === "feas" ? "feasible runs (%)" : "gap (%)"} unit="%" /></div>
            <Legend series={charts.capS} names={charts.capN} /></Card>

          <Card title="Network density" q="Do more links mean lower latency?" csv="density.csv" png="e6_density.png"
            take={<>Extra links shorten paths quickly at first and then flatten out; the heuristics track the exact optimum at every density, while a random placement stays far behind.</>}>
            <div className="plot"><Lines data={charts.dd} series={charts.dS} names={charts.dN} xl="link probability p" yl="mean latency (ms)" logX unit="ms" dashed={["exact_milp"]} /></div>
            <Legend series={charts.dS} names={charts.dN} dashed={["exact_milp"]} /></Card>

          <Card title="Cost vs latency" q="What does each extra dollar per hour buy?" csv="budget.csv" png="e7_budget.png"
            take={<>On the India network the knapsack DP turns budget into lower latency with diminishing returns, always at or below the minimum-replica plan for the same spend.</>}>
            <div className="plot">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart margin={{ top: 8, right: 16, bottom: 18, left: 4 }}>
                  <CartesianGrid stroke="#E8EAED" vertical={false} />
                  <XAxis dataKey="x" type="number" domain={["dataMin", "dataMax"]} tick={{ fontSize: 11, fill: "#5F6368" }} tickLine={false} axisLine={{ stroke: "#DADCE0" }} label={{ value: "VM spend ($/h)", position: "insideBottom", offset: -10, fontSize: 12, fill: "#5F6368" }} tickFormatter={(v: number) => v.toFixed(1)} />
                  <YAxis dataKey="y" domain={[0, "auto"]} tick={{ fontSize: 11, fill: "#5F6368" }} tickLine={false} axisLine={false} width={52} label={{ value: "mean latency (ms)", angle: -90, position: "insideLeft", offset: 12, fontSize: 12, fill: "#5F6368", style: { textAnchor: "middle" } }} />
                  <Tooltip content={({ active, payload }: any) => active && payload?.length ? <div className="chart-tip"><b>${payload[0].payload.x}/h spend</b><div><span>mean latency</span><span>{payload[0].payload.y} ms</span></div><div><span>replicas</span><span>{payload[0].payload.replicas}</span></div></div> : null} />
                  <Line data={charts.bud[0]} dataKey="y" stroke={C[0]} strokeWidth={2} dot={{ r: 3.5, fill: C[0], strokeWidth: 0 }} isAnimationActive={false} />
                  <Line data={charts.bud[1]} dataKey="y" stroke={C[1]} strokeWidth={2} dot={{ r: 3.5, fill: C[1], strokeWidth: 0 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <Legend series={["dp", "min"]} names={{ dp: "Knapsack DP sizing", min: "Minimum replicas" }} /></Card>

          <Card title="Knapsack DP cost" q="Is the dynamic program really Θ(nW)?" csv="knapsack.csv" png="e8_knapsack.png"
            take={<>Runtime grows in a straight line with the number of table cells n·(W+1) on a log-log scale, matching the pseudo-polynomial bound.</>}>
            <div className="plot">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 8, right: 16, bottom: 18, left: 4 }}>
                  <CartesianGrid stroke="#E8EAED" vertical={false} />
                  <XAxis dataKey="x" type="number" scale="log" domain={["auto", "auto"]} tick={{ fontSize: 11, fill: "#5F6368" }} tickLine={false} axisLine={{ stroke: "#DADCE0" }} label={{ value: "DP table cells n·(W+1)", position: "insideBottom", offset: -10, fontSize: 12, fill: "#5F6368" }} />
                  <YAxis dataKey="y" type="number" scale="log" domain={["auto", "auto"]} tick={{ fontSize: 11, fill: "#5F6368" }} tickLine={false} axisLine={false} width={52} label={{ value: "ms", angle: -90, position: "insideLeft", offset: 12, fontSize: 12, fill: "#5F6368" }} />
                  <ZAxis range={[60, 60]} />
                  <Tooltip content={({ active, payload }: any) => active && payload?.length ? <div className="chart-tip"><b>n = {payload[0].payload.n}, W = {payload[0].payload.W}</b><div><span>cells</span><span>{payload[0].payload.x}</span></div><div><span>time</span><span>{payload[0].payload.y} ms</span></div></div> : null} />
                  <Scatter data={charts.ks} fill={C[0]} isAnimationActive={false} />
                </ScatterChart>
              </ResponsiveContainer>
            </div></Card>
        </div>
      )}
    </main>
  );
}
