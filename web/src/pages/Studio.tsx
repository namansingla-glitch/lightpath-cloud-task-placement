import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import NetworkMap from "../components/NetworkMap";
import { CountUp } from "../components/effects";
import { Info } from "../components/Help";
import { getDataset, getDatasets, solve, type SolveConfig } from "../lib/api";
import { fmt, prettyRecommendation, prettyStrategy, serviceColor, shortName, useApp, useAsync } from "../lib/app";
import type { Instance, Route, SolveResult } from "../lib/types";

const STRATS: [string, string, string][] = [["demand_first", "Demand-first", "greedy"], ["marginal_gain", "Marginal gain", "CELF"], ["regret", "Regret", "GAP"], ["ffd_pack", "FFD packing", "bin-pack"]];
type Tab = "routes" | "servers" | "cost" | "sync" | "batch" | "activation";

export default function Studio() {
  const { mode, region, generated } = useApp();
  const [params, setParams] = useSearchParams();
  const dsName = params.get("ds") || region;
  const live = mode === "live";
  const datasets = useAsync(() => getDatasets(), []);

  const [inst, setInst] = useState<Instance | null>(null);
  const [res, setRes] = useState<SolveResult & { _snapshot?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [run, setRun] = useState(0);

  // controls
  const [vm, setVm] = useState(5);
  const [srvOn, setSrvOn] = useState(false);
  const [srv, setSrv] = useState(10);
  const [sizing, setSizing] = useState<"dp" | "min" | "max">("dp");
  const [strats, setStrats] = useState<string[]>(STRATS.map((s) => s[0]));
  const [ls, setLs] = useState(true);
  const [exact, setExact] = useState(true);

  // view state
  const [layers, setLayers] = useState({ mst: false, rep: true, rt: true });
  const [svc, setSvc] = useState<number | null>(null);
  const [sel, setSel] = useState<Route | null>(null);
  const [tab, setTab] = useState<Tab>("routes");
  const [shown, setShown] = useState<string | null>(null);

  const config = (): SolveConfig => ({ vm_budget: vm, server_budget: srvOn ? srv : null, sizing, strategies: strats, local_search: ls, exact: exact ? "auto" : "never" });

  async function doSolve(i: Instance, useDefaults: boolean) {
    setBusy(true); setErr(null);
    try {
      const isGen = dsName === "generated";
      const r = await solve(isGen ? { instance: i, config: useDefaults ? {} : config() } : { dataset: dsName, config: useDefaults ? {} : config() });
      setRes(r); setShown(r.best); setSel(null); setRun((k) => k + 1);
      if (useDefaults && r.sizing?.budget) setVm(r.sizing.budget);
    } catch (e: any) { setErr(String(e.message ?? e)); }
    setBusy(false);
  }

  // load dataset and solve with default settings
  useEffect(() => {
    if (mode == null) return;
    let alive = true;
    setRes(null); setErr(null); setSvc(null); setSel(null);
    (async () => {
      try {
        const i = dsName === "generated" ? generated : await getDataset(dsName);
        if (!i) { setErr("No generated network yet. Create one on the Data page."); return; }
        if (!alive) return;
        setInst(i);
        const total = i.graph.nodes.reduce((a, n) => a + (n.cpu ? n.cost ?? 0 : 0), 0);
        setSrv(Math.round(total * 0.6 * 100) / 100);
        await doSolve(i, true);
      } catch (e: any) { setErr(String(e.message ?? e)); }
    })();
    return () => { alive = false; };
  }, [dsName, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const S = inst?.services ?? [];
  const shownStrat = res?.strategies.find((s) => s.name === shown) ?? res?.strategies.find((s) => s.name === res?.best);
  const isBestShown = shownStrat?.name === res?.best;
  const hosts = useMemo(() => {
    const h: Record<number, number[]> = {};
    if (shownStrat) Object.entries(shownStrat.replicas).forEach(([j, arr]) => arr.forEach((s) => { if (svc === null || svc === +j) (h[s] ||= []).push(+j); }));
    return h;
  }, [shownStrat, svc]);
  const routes = useMemo(() => (res?.policy.routes ?? []).filter((r) => svc === null || r.service_id === svc), [res, svc]);
  const visRoutes = !layers.rt || !isBestShown ? [] : sel ? [sel] : routes;
  const focus = useMemo(() => {
    if (svc === null) return null;
    const f = new Set<number>(); routes.forEach((r) => r.path.forEach((x) => f.add(x))); Object.keys(hosts).forEach((k) => f.add(+k)); return f;
  }, [svc, routes, hosts]);
  const sched = useMemo(() => Object.fromEntries((res?.policy.schedule ?? []).map((r) => [r.server, r])), [res]);

  const best = res?.strategies.find((s) => s.name === res.best);
  const changeDs = (v: string) => { params.set("ds", v); setParams(params, { replace: true }); };
  const snapshot = !!res?._snapshot;

  return (
    <main className="studio">
      <aside className="card rail-c" data-tour="controls">
        <div className="ttl-row"><div className="ttl">Placement studio</div>
          <Info title="Controls">Pick a network, set how much you can spend, choose the methods to compare, then press Solve placement. Everything else on the page updates from that.</Info></div>
        <div className="field"><label className="lab" htmlFor="ds">Network</label>
          <select id="ds" value={dsName} onChange={(e) => changeDs(e.target.value)}>
            {generated && <option value="generated">generated: {generated.name}</option>}
            {(datasets.data ?? []).slice().sort((a, b) => (a.region === region ? 0 : 1) - (b.region === region ? 0 : 1)).map((d) => (
              <option key={d.name} value={d.name}>{d.name} ({d.nodes} nodes)</option>))}
          </select></div>
        <div className="field"><label className="lab" htmlFor="vmb">VM budget <b className="num">${vm.toFixed(2)} / h</b></label>
          <input id="vmb" type="range" min={0.5} max={Math.max(20, Math.ceil(vm * 2))} step={0.1} value={vm} disabled={!live} onChange={(e) => setVm(+e.target.value)} /></div>
        <div className="field"><div className="lab">Server budget <b>{srvOn ? `$${srv.toFixed(2)} / h` : "All servers on"}</b></div>
          <label className="check"><input type="checkbox" checked={srvOn} disabled={!live} onChange={(e) => setSrvOn(e.target.checked)} /> Limit with a knapsack budget</label>
          {srvOn && <input type="range" min={0.5} max={60} step={0.5} value={srv} disabled={!live} onChange={(e) => setSrv(+e.target.value)} style={{ marginTop: 8 }} />}</div>
        <div className="field"><div className="lab">Replica sizing</div>
          <div className="seg">{([["dp", "Knapsack DP"], ["min", "Minimum"], ["max", "Maximum"]] as const).map(([k, l]) =>
            <button key={k} aria-pressed={sizing === k} disabled={!live} onClick={() => setSizing(k)}>{l}</button>)}</div></div>
        <div className="field"><div className="lab">Strategies</div>
          <div className="checks">
            {STRATS.map(([k, l, tag]) => <label key={k} className="check"><input type="checkbox" disabled={!live} checked={strats.includes(k)}
              onChange={(e) => setStrats(e.target.checked ? [...strats, k] : strats.filter((x) => x !== k))} /> {l} <small>{tag}</small></label>)}
            <label className="check"><input type="checkbox" disabled={!live} checked={ls} onChange={(e) => setLs(e.target.checked)} /> Local search refinement</label>
            <label className="check"><input type="checkbox" disabled={!live} checked={exact} onChange={(e) => setExact(e.target.checked)} /> Exact MILP check</label>
          </div></div>
        <button className="solve" data-tour="solve" disabled={busy || !inst || !live || strats.length === 0} onClick={() => inst && doSolve(inst, false)}>{busy ? "Solving…" : "Solve placement"}</button>
        {!live && mode && <p className="mini-note">Showing saved results. Start the Python API (<code>uvicorn api.server:app</code>) to change settings and re-solve live.</p>}
        {inst && <div className="inst-sum">{inst.description}<br />{inst.graph.nodes.length} nodes, {inst.graph.links.length} links, {inst.graph.nodes.filter((n) => (n.cpu ?? 0) > 0).length} servers<br />{S.length} services, {inst.tasks.length} batch jobs{res && <><br />Minimum load {((res.instance.cpu_load_min ?? 0) * 100).toFixed(0)}% of CPU</>}</div>}
      </aside>

      <div className="center">
        <div className="mapwrap" data-tour="map">
          <div className="toolbar">
            <button className="chip" aria-pressed={layers.mst} onClick={() => setLayers({ ...layers, mst: !layers.mst })}><i style={{ background: "var(--red)" }} />Backbone (MST)</button>
            <button className="chip" aria-pressed={layers.rep} onClick={() => setLayers({ ...layers, rep: !layers.rep })}><i style={{ background: "var(--yellow)", boxShadow: "0 0 0 1.5px #B06000 inset" }} />Replicas</button>
            <button className="chip" aria-pressed={layers.rt} onClick={() => setLayers({ ...layers, rt: !layers.rt })}><i style={{ background: "var(--blue)" }} />Routes</button>
          </div>
          <div className="legend">
            <div><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#fff" stroke="#202124" strokeWidth="1.5" /></svg>Core server</div>
            <div><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5" fill="#fff" stroke="#202124" strokeWidth="1.5" /></svg>Regional / edge server</div>
            <div><svg viewBox="0 0 16 16"><rect x="5" y="5" width="6" height="6" fill="#9AA0A6" transform="rotate(45 8 8)" /></svg>Router (cannot host)</div>
            <div><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="#FBBC05" stroke="#B06000" /></svg>Hosts replicas</div>
            {!isBestShown && shownStrat && <div style={{ color: "var(--primary)" }}>Showing: {prettyStrategy(shownStrat.name)}</div>}
          </div>
          {inst && res ? (
            <NetworkMap nodes={inst.graph.nodes} links={inst.graph.links} variant="studio" hosts={hosts} showReplicas={layers.rep}
              routes={visRoutes} routeColor={(r) => serviceColor(r.service_id)} mst={res.topology.mst.edges} showMst={layers.mst} focusNodes={focus}
              renderTip={(i) => {
                const n = inst.graph.nodes[i], sc = sched[i]; const vms = Object.entries(shownStrat?.replicas ?? {}).filter(([, a]) => a.includes(i)).map(([j]) => +j);
                const dem = S.reduce((a, s) => a + (s.demand[String(i)] || 0), 0);
                return <><h5>{n.name}</h5><div className="r"><span>Tier</span><b>{n.tier}</b></div>
                  {n.cpu ? <><div className="r"><span>CPU used</span><b className="num">{sc ? sc.cpu_used : 0} / {n.cpu}</b></div><div className="r"><span>Memory used</span><b className="num">{sc ? sc.mem_used : 0} / {n.mem} GB</b></div></> : <div className="r"><span>Hosting</span><b>not possible</b></div>}
                  <div className="r"><span>User demand</span><b className="num">{dem.toFixed(0)} req/s</b></div>
                  {vms.length > 0 && <div style={{ marginTop: 6 }}>{vms.map((j) => <span key={j} className="vm"><i className="sw" style={{ background: serviceColor(j), width: 7, height: 7, marginRight: 5 }} />{S[j].name}</span>)}</div>}</>;
              }} />
          ) : <div className="loading" style={{ height: "100%" }}><div><div className="spin" />{err ? "" : busy ? "Solving" : "Loading"}</div></div>}
          <div className="svc-row">
            <button className="chip" aria-pressed={svc === null} onClick={() => { setSvc(null); setSel(null); }}><span>All services</span></button>
            {S.map((s, j) => <button key={j} className="chip" aria-pressed={svc === j} onClick={() => { setSvc(j); setSel(null); }}><i style={{ background: serviceColor(j) }} /><span>{s.name}</span></button>)}
          </div>
          <Info title="The map" className="mapinfo">Yellow sites host copies of services, coloured dots show which ones, and lines show each group of users' route to its nearest copy. Scroll to zoom, drag to move, hover a site for details, and use the chips to filter.</Info>
        </div>
        <div className="card tabs" data-tour="tabs">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingRight: 14 }}>
            <div className="tablist" role="tablist">
              {([["routes", "Routes"], ["servers", "Servers"], ["cost", "Cost and benefit"], ["sync", "Replica sync"], ["batch", "Batch jobs"], ...(res?.activation ? [["activation", "Server activation"]] : [])] as [Tab, string][]).map(([k, l]) =>
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
            </div>
            <Info title="Detail tabs">Routes: who is served from where. Servers: how full each one is. Cost and benefit: what each extra copy buys. Replica sync: fastest versus cheapest path between copies. Batch jobs: a timeline of background work.</Info>
          </div>
          <div className="tabbody">{res && inst ? <Tabs tab={tab} res={res} inst={inst} routes={routes} sel={sel} setSel={setSel} /> : null}</div>
        </div>
      </div>

      <aside className="card results" data-tour="results">
        {err && <div className="banner err">{err}</div>}
        {snapshot && <div className="banner">Saved results with default settings. Start the Python API to re-solve live.</div>}
        {res?.warnings?.length ? <div className="banner">{res.warnings.join(" ")}</div> : null}
        <div className="readouts">
          <div><b><CountUp to={best?.mean_ms ?? NaN} decimals={2} duration={900} trigger={run} /><small>ms</small></b><span>average latency</span></div>
          <div><b><CountUp to={best?.p95_ms ?? NaN} decimals={2} duration={900} trigger={run} /><small>ms</small></b><span>95th percentile</span></div>
          <div><b><CountUp to={best?.cost_per_hour ?? NaN} decimals={2} duration={900} trigger={run} /><small>$/h</small></b><span>VM cost</span></div>
          <div><b><CountUp to={res?.total_runtime_ms ?? NaN} decimals={0} duration={900} trigger={run} /><small>ms</small></b><span>full pipeline</span></div>
        </div>
        {res && <p className="verdict">Best plan: <strong>{prettyStrategy(res.best)}</strong>. {res.exact.objective != null
          ? <>The exact optimum is {fmt(res.exact.objective, 3)} ms, found by the MILP in {fmt(res.exact.runtime_ms, 0)} ms.</>
          : <>The exact check was skipped ({res.exact.status}).</>}</p>}
        {res && <div>
          <div className="h-sub"><span>Average latency by strategy</span><span style={{ display: "flex", gap: 8, alignItems: "center" }}>ms, lower is better <Info title="Comparing methods">One bar per method; shorter means faster for users. The dashed green line is the proven best answer, so a bar that reaches it is optimal. Click a bar to show that method's placement on the map.</Info></span></div>
          <StrategyChart res={res} shown={shownStrat?.name ?? null} onPick={(n) => { setShown(n); setSel(null); }} />
        </div>}
        {res && <div><div className="h-sub"><span>Recommendations</span></div>
          <ul className="recs">{res.recommendations.map((r, k) => <li key={k}>{prettyRecommendation(r)}</li>)}</ul></div>}
      </aside>
    </main>
  );
}

function StrategyChart({ res, shown, onPick }: { res: SolveResult; shown: string | null; onPick: (n: string) => void }) {
  const rows = res.strategies.filter((s) => s.feasible && s.mean_ms != null).slice().sort((a, b) => a.mean_ms! - b.mean_ms!);
  const infeasible = res.strategies.filter((s) => !s.feasible);
  const max = Math.max(...rows.map((r) => r.mean_ms!), 1e-9);
  const ex = res.exact.objective;
  return (
    <div className="stratchart">
      {rows.map((r) => (
        <button key={r.name} className={`srow ${r.name === res.best ? "best" : ""} ${r.name.endsWith("+ls") ? "ls" : ""} ${r.name === "exact_milp" ? "opt" : ""}`}
          onClick={() => onPick(r.name)} style={{ width: "100%", background: r.name === shown ? "var(--surface)" : "none", border: 0, borderRadius: 10, cursor: "pointer", textAlign: "left", font: "inherit" }}
          title={`${prettyStrategy(r.name)}: ${fmt(r.mean_ms, 3)} ms, gap ${fmt(r.gap_pct, 2)}%, ${fmt(r.runtime_ms, 1)} ms to compute`}>
          <span className="nm">{prettyStrategy(r.name)}</span>
          <div className="tr"><i style={{ width: `${(100 * r.mean_ms!) / max}%` }} /></div>
          <span className="v num">{fmt(r.mean_ms, 2)}</span>
        </button>
      ))}
      {ex != null && <div className="optline" style={{ left: `calc(152px + (100% - 222px) * ${ex / max})` }} />}
      {infeasible.length > 0 && <p className="mini-note">Could not fit every replica: {infeasible.map((s) => prettyStrategy(s.name)).join(", ")}.</p>}
    </div>
  );
}

function Tabs({ tab, res, inst, routes, sel, setSel }: { tab: Tab; res: SolveResult; inst: Instance; routes: Route[]; sel: Route | null; setSel: (r: Route | null) => void }) {
  const S = inst.services; const N = inst.graph.nodes;
  if (tab === "routes") return (
    <table><thead><tr><th>Service</th><th>Users in</th><th>Served from</th><th>Path</th><th className="r">Requests/s</th><th className="r">Latency</th><th className="r">Backbone only</th></tr></thead>
      <tbody>{routes.map((r, k) => (
        <tr key={k} className={sel === r ? "sel" : ""} onClick={() => setSel(sel === r ? null : r)}>
          <td><i className="sw" style={{ background: serviceColor(r.service_id) }} />{r.service}</td><td>{shortName(r.client_name)}</td><td>{shortName(r.replica_name)}</td>
          <td className="path">{r.path_names.map(shortName).join(" → ")}</td><td className="r num">{r.rate.toFixed(0)}</td><td className="r num">{r.latency_ms.toFixed(2)} ms</td><td className="r num">{fmt(r.stretch, 2)}×</td></tr>))}
      </tbody></table>);
  if (tab === "servers") return (
    <table><thead><tr><th>Server</th><th>Tier</th><th>Running</th><th>CPU</th><th>Memory</th></tr></thead>
      <tbody>{res.policy.schedule.map((r: any) => (
        <tr key={r.server}><td>{shortName(r.name)}</td><td style={{ color: "var(--ink2)" }}>{r.tier}</td>
          <td>{r.vms.length ? r.vms.map((v: string) => { const j = S.findIndex((x) => x.name === v); return <span key={v} className="vm"><i className="sw" style={{ background: serviceColor(j), width: 7, height: 7, marginRight: 5 }} />{v}</span>; }) : <span style={{ color: "var(--ink3)" }}>idle</span>}</td>
          <td><Bar v={r.cpu_util} label={`${r.cpu_used}/${r.cpu_cap}`} /></td><td><Bar v={r.mem_util} label={`${r.mem_used}/${r.mem_cap}`} /></td></tr>))}
      </tbody></table>);
  if (tab === "cost") {
    const by: Record<number, any[]> = {}; res.sizing.table.forEach((r) => (by[r.service_id] ||= []).push(r));
    const K = Math.max(1, ...res.sizing.table.map((r) => r.replicas));
    return (<>
      <p className="mini-note" style={{ margin: "8px 0 6px", fontSize: 13 }}>Average latency in ms for each replica count. Blue is what the knapsack DP bought within the ${res.sizing.budget}/h budget (spent ${res.sizing.spend}/h).{res.sizing.trimmed_for_capacity.length ? ` Trimmed to fit capacity: ${res.sizing.trimmed_for_capacity.join(", ")}.` : ""}</p>
      <table><thead><tr><th>Service</th><th className="r">$ per replica-hour</th>{Array.from({ length: K }, (_, k) => <th key={k} className="r">{k + 1}</th>)}<th className="r">Next replica saves</th></tr></thead>
        <tbody>{S.map((s, j) => {
          const rows = by[j] || []; const target = res.sizing.targets[j]; const nx = rows.find((r) => r.replicas === target + 1);
          return <tr key={j}><td><i className="sw" style={{ background: serviceColor(j) }} />{s.name}</td><td className="r num">{s.vm_cost.toFixed(3)}</td>
            {Array.from({ length: K }, (_, k) => { const r = rows.find((x) => x.replicas === k + 1); return <td key={k} className={`r num ${r && r.replicas === target ? "chosen" : ""}`}>{r ? fmt(r.avg_latency_ms, 2) : <span style={{ color: "var(--ink3)" }}>–</span>}</td>; })}
            <td className="r num" style={{ color: "var(--ink2)" }}>{nx ? `${fmt(nx.marginal_saving_ms, 2)} ms ($${s.vm_cost.toFixed(2)})` : target === 0 ? "cannot be hosted" : "at maximum"}</td></tr>;
        })}</tbody></table></>);
  }
  if (tab === "sync") {
    const tr = res.policy.transfer;
    if (!tr) return <p className="mini-note">No replica sync data.</p>;
    if (tr.error) return <div className="banner err">{tr.error}</div>;
    return (<>
      <p className="mini-note" style={{ margin: "8px 0 6px", fontSize: 13 }}>Replica-to-replica sync traffic. {tr.negative_arcs} directed links have a negative cost (a rebate set by regional price levels), so the cheapest route comes from Johnson's algorithm, not Dijkstra.</p>
      {tr.rows.length === 0 ? <p className="mini-note">No service has more than one replica, so nothing needs syncing.</p> :
        <table><thead><tr><th>Service</th><th>From</th><th>To</th><th>Fastest path</th><th className="r">ms</th><th className="r">$/GB</th><th>Cheapest path</th><th className="r">ms</th><th className="r">$/GB</th><th className="r">Saving</th></tr></thead>
          <tbody>{tr.rows.map((r, k) => <tr key={k}><td>{r.service}</td><td>{shortName(r.from)}</td><td>{shortName(r.to)}</td><td className="path">{r.fast_path.map(shortName).join(" → ")}</td><td className="r num">{fmt(r.fast_latency_ms, 1)}</td><td className="r num">{fmt(r.fast_cost_per_gb, 4)}</td><td className="path">{r.cheap_path.map(shortName).join(" → ")}</td><td className="r num">{fmt(r.cheap_latency_ms, 1)}</td><td className="r num">{fmt(r.cheap_cost_per_gb, 4)}</td><td className="r num" style={{ color: r.saving_per_gb > 0 ? "var(--primary)" : "var(--ink3)" }}>{r.saving_per_gb > 0 ? fmt(r.saving_per_gb, 4) : "same"}</td></tr>)}</tbody></table>}</>);
  }
  if (tab === "activation" && res.activation) {
    const a = res.activation;
    return (<><p className="mini-note" style={{ margin: "8px 0 6px", fontSize: 13 }}>The 0/1 knapsack DP kept {a.chosen.length} servers on within ${a.budget}/h (cost ${a.cost}/h){a.repaired.length ? `; ${a.repaired.length} were added back so the minimum replicas still fit` : ""}{a.over_budget ? ", which goes over the budget" : ""}.</p>
      <table><thead><tr><th>Server</th><th>Tier</th><th className="r">$/h</th><th>Status</th></tr></thead><tbody>
        {N.map((n, i) => n.cpu ? <tr key={i}><td>{shortName(n.name)}</td><td style={{ color: "var(--ink2)" }}>{n.tier}</td><td className="r num">{fmt(n.cost, 2)}</td><td>{a.chosen.includes(i) ? (a.repaired.includes(i) ? "on (added for capacity)" : "on") : <span style={{ color: "var(--ink3)" }}>off</span>}</td></tr> : null)}
      </tbody></table></>);
  }
  // batch
  const b = res.policy.batch;
  if (!b || !b.entries.length) return <p className="mini-note">This network has no batch jobs.</p>;
  const lanes = [...new Set(b.entries.map((e) => `${e.server}/${e.lane}`))].sort((x, y) => N[+x.split("/")[0]].name.localeCompare(N[+y.split("/")[0]].name));
  const W = 900, rowH = 22, left = 150, H = lanes.length * rowH + 34; const x = (v: number) => left + ((W - left - 10) * v) / b.makespan;
  const ticks = Array.from({ length: Math.floor(b.makespan / 20) + 1 }, (_, k) => k * 20);
  return (<>
    <p className="mini-note" style={{ margin: "8px 0 0", fontSize: 13 }}>{b.entries.length} batch jobs, longest first, each sent to the server lane where it finishes earliest after its input data arrives.</p>
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 640, display: "block", marginTop: 8 }} role="img" aria-label="Batch job timeline">
      {ticks.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={0} y2={H - 24} stroke="#E8EAED" /><text x={x(t)} y={H - 8} fill="#80868B" fontSize={11} textAnchor="middle">{t}s</text></g>)}
      {lanes.map((ln, i) => { const [sv, lane] = ln.split("/"); return <text key={ln} x={0} y={i * rowH + 15} fill="#5F6368" fontSize={12}>{shortName(N[+sv].name)}{+lane > 0 ? `, lane ${+lane + 1}` : ""}</text>; })}
      {b.entries.map((e, k) => { const i = lanes.indexOf(`${e.server}/${e.lane}`), y = i * rowH + 4; const w = Math.max(2, x(e.end) - x(e.start) - 2);
        return <g key={k}><rect x={x(e.start)} y={y} width={w} height={rowH - 8} rx={4} fill="#4285F4" fillOpacity={0.8}><title>{`${e.name}: ${e.start}s to ${e.end}s on ${N[e.server].name} (data arrives at ${e.transfer}s)`}</title></rect>
          {w > 60 && <text x={x(e.start) + 6} y={y + 11} fill="#fff" fontSize={11} fontWeight={600}>{e.name}</text>}</g>; })}
      <line x1={x(b.makespan)} x2={x(b.makespan)} y1={0} y2={H - 24} stroke="#EA4335" strokeDasharray="4 3" />
      <text x={x(b.makespan) - 4} y={H - 28} fill="#D93025" fontSize={11} textAnchor="end">makespan {b.makespan}s</text>
    </svg></>);
}

function Bar({ v, label }: { v: number; label: string }) {
  return <div style={{ display: "flex", gap: 8, alignItems: "center" }}><div className={`bar ${v >= 0.9 ? "hot" : ""}`} style={{ flex: 1 }}><i style={{ width: `${Math.min(100, v * 100)}%` }} /></div><span className="num" style={{ color: "var(--ink2)", width: 72, textAlign: "right" }}>{label}</span></div>;
}
