import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { detectMode, type Mode } from "./api";
import type { Instance } from "./types";

/* Service colours: validated categorical palette (CVD-checked on white) in fixed order. */
export const SERVICE_PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const serviceColor = (j: number) => SERVICE_PALETTE[j % SERVICE_PALETTE.length];
export const G = { blue: "#4285F4", red: "#EA4335", yellow: "#FBBC05", green: "#34A853", ink: "#202124", primary: "#1A73E8" };

const STRAT: Record<string, string> = { random: "Random", demand_first: "Demand-first", marginal_gain: "Marginal gain", regret: "Regret", ffd_pack: "FFD packing", exact_milp: "Exact optimum" };
export const prettyStrategy = (n: string) => (STRAT[n.replace("+ls", "")] ?? n) + (n.endsWith("+ls") ? " + LS" : "");
export const prettyRecommendation = (s: string) => s.replace(/'([a-z_+]+)'/g, (_, n) => prettyStrategy(n));
export const shortName = (n: string) => n.replace(/ \(.*\)$/, "");
export const fmt = (v: number | null | undefined, d = 2) => (v == null || !isFinite(v) ? "–" : v.toFixed(d));

export type Region = "india" | "nigeria";

interface AppState {
  mode: Mode | null;
  region: Region; setRegion: (r: Region) => void;
  motion: boolean; setMotion: (m: boolean) => void;
  generated: Instance | null; setGenerated: (i: Instance | null) => void;
  tourOn: boolean; setTourOn: (b: boolean) => void;
}
const Ctx = createContext<AppState | null>(null);

function stored<T>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : init; } catch { return init; }
  });
  const set = (x: T) => { setV(x); try { localStorage.setItem(key, JSON.stringify(x)); } catch { /* private mode */ } };
  return [v, set];
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [region, setRegion] = stored<Region>("lp.region", "india");
  const reducedOS = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [motion, setMotion] = stored<boolean>("lp.motion", !reducedOS);
  const [generated, setGenerated] = useState<Instance | null>(null);
  const [tourOn, setTourOn] = useState(false);
  useEffect(() => { detectMode().then(setMode); }, []);
  const value = useMemo(() => ({ mode, region, setRegion, motion, setMotion, generated, setGenerated, tourOn, setTourOn }),
    [mode, region, motion, generated, tourOn]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApp outside provider");
  return c;
}

/** Small async hook: { data, error, loading } with re-run on deps. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  useEffect(() => {
    let alive = true;
    setState({ data: null, loading: true, error: null }); // never mix results from a previous selection
    fn().then((d) => alive && setState({ data: d, error: null, loading: false }))
      .catch((e) => alive && setState({ data: null, error: String(e.message ?? e), loading: false }));
    return () => { alive = false; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

export function download(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
