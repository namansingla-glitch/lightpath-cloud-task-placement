export interface GNode { id: number; name: string; x: number; y: number; tier?: string; cpu?: number; mem?: number; cost?: number; lat?: number; lon?: number; }
export interface GLink { u: number; v: number; latency: number; bandwidth: number; [k: string]: unknown; }
export interface Service { id: number; name: string; cpu: number; mem: number; demand: Record<string, number>; min_replicas: number; max_replicas: number; vm_cost: number; priority: number; color?: string; }
export interface Instance {
  name: string; description: string; source: string; budget: number | null; meta: Record<string, any>;
  graph: { directed: boolean; nodes: GNode[]; links: GLink[] };
  services: Service[]; tasks: any[]; summary?: Record<string, any>;
}
export interface DatasetInfo { name: string; model: string; description: string; source: string; region?: string; nodes: number; links: number; servers: number; services: number; density: number; best: string; best_mean_ms: number; cpu_load_min?: number; }
export interface Strategy { name: string; feasible: boolean; mean_ms: number | null; p50_ms: number | null; p95_ms: number | null; max_ms: number | null; runtime_ms: number | null; cost_per_hour: number | null; replicas: Record<string, number[]>; notes: string[]; gap_pct: number | null; stats: Record<string, any>; violations: string[]; }
export interface Route { service: string; service_id: number; client: number; client_name: string; replica: number; replica_name: string; rate: number; latency_ms: number; hops: number; path: number[]; path_names: string[]; backbone_latency_ms: number; stretch: number; }
export interface SolveResult {
  instance: Record<string, any>; warnings: string[]; config: Record<string, any>;
  topology: { apsp: { algorithm: string; runtime_ms: number; density: number }; mst: { algorithm: string; edges: { u: number; v: number; w: number }[]; total_weight: number; components: number; runtime_ms: number }; diameter_ms: number };
  activation?: { budget: number; chosen: number[]; cost: number; over_budget: boolean; repaired: number[] };
  sizing: { mode: string; budget: number; targets: number[]; spend: number; feasible: boolean; table: any[]; trimmed_for_capacity: string[] };
  exact: { objective: number | null; runtime_ms?: number; optimal?: boolean; status?: string };
  strategies: Strategy[]; best: string;
  policy: { schedule: any[]; routes?: Route[]; transfer?: { algorithm?: string; negative_arcs: number; rows: any[]; error?: string }; batch?: { entries: any[]; makespan: number; rule: string } };
  recommendations: string[]; total_runtime_ms: number;
}
export interface AlgoResult { algorithm: string; runtime_ms: number; trace?: any[]; trace_truncated?: boolean; dist?: any; parent?: number[]; edges?: { u: number; v: number; w: number }[]; total_weight?: number; source?: number; negative_arcs?: [number, number, number][]; auto_choice?: string; meta?: any; relaxations?: number; components?: number; }
export interface Experiments { generated: string; quick: boolean; results: Record<string, any[]>; }
