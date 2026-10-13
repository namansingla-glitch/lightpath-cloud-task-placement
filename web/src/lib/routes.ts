import type { AlgoResult, Instance } from "./types";

/** Helpers that turn an algorithm result into a concrete start → destination route. */
export function adjacency(inst: Instance) {
  const adj: [number, number][][] = inst.graph.nodes.map(() => []);
  for (const l of inst.graph.links) { adj[l.u].push([l.v, l.latency]); adj[l.v].push([l.u, l.latency]); }
  return adj;
}

export function linkLatency(inst: Instance, u: number, v: number) {
  let best = Infinity;
  for (const l of inst.graph.links) if ((l.u === u && l.v === v) || (l.u === v && l.v === u)) best = Math.min(best, l.latency);
  return best;
}

export const pathLatency = (inst: Instance, path: number[]) =>
  path.slice(1).reduce((s, v, i) => s + linkLatency(inst, path[i], v), 0);

/** Fastest route by latency (plain Dijkstra, used for the all-pairs views). */
export function fastestPath(inst: Instance, s: number, t: number): number[] {
  const adj = adjacency(inst), n = adj.length, dist = Array(n).fill(Infinity), par = Array(n).fill(-1), done = Array(n).fill(false);
  dist[s] = 0;
  for (let it = 0; it < n; it++) {
    let u = -1; for (let k = 0; k < n; k++) if (!done[k] && (u < 0 || dist[k] < dist[u])) u = k;
    if (u < 0 || dist[u] === Infinity) break; done[u] = true; if (u === t) break;
    for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; par[v] = u; }
  }
  return fromParent(par, s, t);
}

export function fromParent(parent: number[] | undefined, s: number, t: number): number[] {
  if (!parent) return [];
  const path = [t]; let guard = 0;
  while (path[path.length - 1] !== s) { const p = parent[path[path.length - 1]]; if (p == null || p < 0 || ++guard > parent.length) return []; path.push(p); }
  return path.reverse();
}

/** Route inside a spanning tree (unique path). */
export function treePath(edges: { u: number; v: number }[] | undefined, n: number, s: number, t: number): number[] {
  if (!edges) return [];
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) { adj[e.u].push(e.v); adj[e.v].push(e.u); }
  const par = Array(n).fill(-1); par[s] = s; const q = [s];
  while (q.length) { const u = q.shift()!; if (u === t) break; for (const v of adj[u]) if (par[v] < 0) { par[v] = u; q.push(v); } }
  if (par[t] < 0) return [];
  const p = [t]; while (p[p.length - 1] !== s) p.push(par[p[p.length - 1]]); return p.reverse();
}

/** Index of the trace event after which the destination's route is final (or null if the whole run is needed). */
export function answerStep(alg: string, res: AlgoResult, s: number, t: number, n: number): number | null {
  const tr = res.trace ?? [];
  if (alg === "dijkstra") { const i = tr.findIndex((e: any) => e.type === "settle" && e.u === t); return i < 0 ? null : i + 1; }
  if (alg === "prim") { const i = tr.findIndex((e: any) => e.type === "add_edge" && e.v === t); return i < 0 ? null : i + 1; }
  if (alg === "kruskal") {
    const p = Array.from({ length: n }, (_, i) => i); const f = (x: number): number => (p[x] === x ? x : (p[x] = f(p[x])));
    for (let i = 0; i < tr.length; i++) { const e: any = tr[i]; if (e.type === "add_edge") { p[f(e.u)] = f(e.v); if (f(s) === f(t)) return i + 1; } }
    return null;
  }
  return null;
}
