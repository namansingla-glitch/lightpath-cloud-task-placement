/* Data layer: talks to the Python API when it is running, otherwise serves
   the pre-computed snapshot in /demo so the site still works offline or on a
   static host. */
import type { AlgoResult, DatasetInfo, Experiments, Instance, SolveResult } from "./types";

export type Mode = "live" | "snapshot";
const BASE = (import.meta.env.VITE_API as string | undefined) ?? "";
let modePromise: Promise<Mode> | null = null;

export function detectMode(): Promise<Mode> {
  if (!modePromise) {
    modePromise = (async () => {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 1500);
        const r = await fetch(`${BASE}/api/health`, { signal: ctl.signal });
        clearTimeout(t);
        if (r.ok && (await r.json()).ok) return "live";
      } catch { /* fall through */ }
      return "snapshot";
    })();
  }
  return modePromise;
}

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.json();
}
async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); if (j.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}
const snap = (p: string) => `./demo/${p}`;

const cache = new Map<string, Promise<any>>();
function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key)!;
}

export async function getDatasets(): Promise<DatasetInfo[]> {
  const m = await detectMode();
  return cached("datasets", () => getJSON(m === "live" ? `${BASE}/api/datasets` : snap("datasets.json")));
}

export async function getDataset(name: string): Promise<Instance> {
  const m = await detectMode();
  return cached(`ds:${name}`, () => getJSON(m === "live" ? `${BASE}/api/datasets/${encodeURIComponent(name)}` : snap(`datasets/${name}.json`)));
}

export interface SolveConfig {
  vm_budget?: number | null;
  server_budget?: number | null;
  sizing?: "dp" | "min" | "max";
  strategies?: string[];
  local_search?: boolean;
  exact?: "auto" | "always" | "never";
}

export async function solve(args: { dataset?: string; instance?: Instance; config?: SolveConfig }): Promise<SolveResult & { _snapshot?: boolean }> {
  const m = await detectMode();
  if (m === "live") return postJSON(`${BASE}/api/solve`, { dataset: args.dataset, instance: args.instance, config: args.config ?? {} });
  if (!args.dataset) throw new Error("Generated networks need the Python API. Start it with: uvicorn api.server:app");
  const r: any = await cached(`solve:${args.dataset}`, () => getJSON(snap(`solve/${args.dataset}.json`)));
  return { ...r, _snapshot: true };
}

export async function runAlgorithm(args: { dataset?: string; instance?: Instance; algorithm: string; source: number; heap: string }): Promise<AlgoResult & { _snapshot?: boolean }> {
  const m = await detectMode();
  if (m === "live") return postJSON(`${BASE}/api/algorithms/run`, args);
  if (!args.dataset) throw new Error("Generated networks need the Python API.");
  const per = args.source > 0 && ["dijkstra", "bellman_ford", "prim"].includes(args.algorithm);
  const file = per ? `${args.algorithm}-${args.source}` : args.algorithm;
  const r: any = await cached(`algo:${args.dataset}:${file}`, () => getJSON(snap(`algo/${args.dataset}/${file}.json`)));
  return { ...r, _snapshot: true };
}

export async function generate(req: Record<string, unknown>): Promise<Instance> {
  const m = await detectMode();
  if (m !== "live") throw new Error("Generating networks needs the Python API. Start it with: uvicorn api.server:app --port 8000");
  return postJSON(`${BASE}/api/generate`, req);
}

export async function getExperiments(): Promise<Experiments> {
  const m = await detectMode();
  return cached("experiments", async () => {
    if (m === "live") { try { return await getJSON(`${BASE}/api/experiments`); } catch { /* fall back */ } }
    return getJSON(snap("experiments.json"));
  });
}

/** Static downloads shipped with the site (same files in both modes). */
export const fileUrl = (p: string) => snap(`files/${p}`);
