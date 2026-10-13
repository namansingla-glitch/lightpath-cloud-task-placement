import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { MiniGraph } from "../components/NetworkMap";
import { Info } from "../components/Help";
import { fileUrl, generate, getDatasets } from "../lib/api";
import { download, useApp, useAsync } from "../lib/app";

const MODELS: [string, string, boolean][] = [["waxman", "Waxman (geographic WAN)", true], ["erdos_renyi", "Erdős–Rényi (random)", true], ["barabasi_albert", "Barabási–Albert (scale-free)", true],
  ["fat_tree", "Fat-tree data centre", false], ["india", "India (real cities)", false], ["nigeria", "Nigeria (real cities)", false], ["woxsen", "Woxsen campus", false], ["abilene", "Abilene backbone", false], ["nsfnet", "NSFNET backbone", false]];
const SRC: Record<string, string> = { real: "Real topology", "real-coordinates": "Real city locations", "campus-map": "From the campus map", synthetic: "Synthetic" };

export default function Data() {
  const { mode, setGenerated, generated } = useApp();
  const nav = useNavigate();
  const list = useAsync(() => getDatasets(), []);
  const [f, setF] = useState({ model: "waxman", n: 40, seed: 1, services: 8, capacity_factor: 1 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = mode === "live";
  const sized = MODELS.find((m) => m[0] === f.model)?.[2];

  const gen = async () => {
    setBusy(true); setErr(null);
    try {
      const params = f.model === "fat_tree" ? { k: 4 } : {};
      const inst = await generate({ model: f.model, n: f.n, seed: f.seed, services: f.services, capacity_factor: f.capacity_factor, tasks: 12, params });
      setGenerated(inst); nav("/studio?ds=generated");
    } catch (e: any) { setErr(String(e.message ?? e)); }
    setBusy(false);
  };

  return (
    <main className="page-pad">
      <div className="page-head"><div><h1>Data</h1>
        <p>Every network used in the project. Download a network as JSON or as a Gephi file, download its solved plan as CSV tables, or generate a brand-new random network and open it in the studio.</p></div></div>

      <section className="gen" aria-label="Generate a network">
        <h3 style={{ display: "flex", alignItems: "center", gap: 10 }}>Generate a network
          <Info title="Network generator">Builds a new network with the same latency model (fibre at 200 km per ms with route detours) and random services. The seed makes it repeatable: the same settings always give the same network.</Info></h3>
        <div className="field"><label className="lab" htmlFor="g-model">Model</label><select id="g-model" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}>{MODELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field"><label className="lab" htmlFor="g-n">Sites</label><input id="g-n" type="number" min={6} max={600} value={f.n} disabled={!sized} onChange={(e) => setF({ ...f, n: Math.max(6, Math.min(600, +e.target.value || 6)) })} /></div>
        <div className="field"><label className="lab" htmlFor="g-s">Services</label><input id="g-s" type="number" min={1} max={40} value={f.services} onChange={(e) => setF({ ...f, services: Math.max(1, Math.min(40, +e.target.value || 1)) })} /></div>
        <div className="field"><label className="lab" htmlFor="g-c">Capacity ×</label><input id="g-c" type="number" min={0.1} max={5} step={0.05} value={f.capacity_factor} onChange={(e) => setF({ ...f, capacity_factor: Math.max(0.1, Math.min(5, +e.target.value || 1)) })} /></div>
        <div className="field"><label className="lab" htmlFor="g-seed">Seed</label><input id="g-seed" type="number" value={f.seed} onChange={(e) => setF({ ...f, seed: +e.target.value || 0 })} /></div>
        <button className="btn primary" disabled={!live || busy} onClick={gen}>{busy ? "Generating…" : "Generate and open"}</button>
        {!live && mode && <p className="mini-note" style={{ gridColumn: "1/-1" }}>Generating needs the Python API. Start it with <code>uvicorn api.server:app --port 8000</code> and reload.</p>}
        {err && <div className="banner err" style={{ gridColumn: "1/-1", margin: 0 }}>{err}</div>}
        {generated && <p className="mini-note" style={{ gridColumn: "1/-1" }}>Last generated: <b>{generated.name}</b>, {generated.graph.nodes.length} sites. <button className="btn tonal" style={{ height: 30, padding: "0 12px", fontSize: 12.5 }} onClick={() => download(`${generated.name}.json`, JSON.stringify(generated, null, 1))}>Download JSON</button></p>}
      </section>

      {list.error && <div className="banner err">{list.error}</div>}
      <div className="ds-list" data-tour="datasets">
        {(list.data ?? []).map((d: any) => (
          <article key={d.name} className="dcard">
            {d.preview ? <MiniGraph nodes={d.preview.n} edges={d.preview.e} /> : <div />}
            <div>
              <h3>{d.name}<span className="tag">{SRC[d.source] ?? d.source}</span>{d.region && d.region !== "global" && <span className="tag">{d.region === "india" ? "India" : "Nigeria"}</span>}</h3>
              <p>{d.description}</p>
              <div className="kv">
                <span><b>{d.nodes}</b> sites</span><span><b>{d.links}</b> links</span><span><b>{d.servers}</b> servers</span>
                <span><b>{d.services}</b> services</span><span>density <b>{d.density}</b></span><span>load <b>{Math.round((d.cpu_load_min ?? 0) * 100)}%</b></span>
                <span style={{ gridColumn: "1/-1" }}>best plan <b>{d.best_mean_ms} ms</b> average latency</span>
              </div>
              <div className="dl">
                <button className="open" onClick={() => nav(`/studio?ds=${d.name}`)}>Open in studio</button>
                <a href={fileUrl(`${d.name}.json`)} download>JSON</a>
                <a href={fileUrl(`gexf/${d.name}.gexf`)} download>Gephi (GEXF)</a>
                <a href={fileUrl(`policies/${d.name}_routes.csv`)} download>Routes CSV</a>
                <a href={fileUrl(`policies/${d.name}_schedule.csv`)} download>Servers CSV</a>
                <a href={fileUrl(`policies/${d.name}_cost_benefit.csv`)} download>Cost/benefit CSV</a>
                <a href={fileUrl(`policies/${d.name}_strategies.csv`)} download>Strategies CSV</a>
              </div>
            </div>
          </article>
        ))}
      </div>
    </main>
  );
}
