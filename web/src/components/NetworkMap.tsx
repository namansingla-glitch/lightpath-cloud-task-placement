import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GLink, GNode, Route } from "../lib/types";
import { serviceColor, shortName, useApp } from "../lib/app";

export type EdgeMark = "tree" | "consider" | "relax" | "reject" | "negative" | "path";
export const ekey = (u: number, v: number) => (u < v ? `${u}-${v}` : `${v}-${u}`);

interface Props {
  nodes: GNode[];
  links: GLink[];
  variant?: "hero" | "studio" | "lab";
  hosts?: Record<number, number[]>;
  showReplicas?: boolean;
  routes?: Route[];
  routeColor?: (r: Route) => string;
  mst?: { u: number; v: number }[];
  showMst?: boolean;
  focusNodes?: Set<number> | null;          // others are dimmed
  nodeMark?: Record<number, "settled" | "frontier" | "current" | "source" | "target">;
  edgeMark?: Record<string, EdgeMark>;
  extraArcs?: { u: number; v: number; kind: "negative" }[];
  badges?: Record<number, string>;          // small text under a node (e.g. distance)
  renderTip?: (i: number) => ReactNode;
  pad?: number;
  interactive?: boolean;
}

const nodeR = (n: GNode) => (n.tier === "core" ? 9 : n.tier === "regional" ? 7 : n.tier === "edge" ? 5.5 : 3.5);
const pathD = (nodes: GNode[], path: number[]) => path.map((v, i) => (i ? "L" : "M") + nodes[v].x + " " + nodes[v].y).join(" ");

export default function NetworkMap(p: Props) {
  const { motion } = useApp();
  const variant = p.variant ?? "studio";
  const uid = useMemo(() => "m" + Math.random().toString(36).slice(2, 8), []);
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ z: 1, tx: 0, ty: 0 });
  const [tip, setTip] = useState<{ i: number; x: number; y: number } | null>(null);

  const vb = useMemo(() => {
    const pad = p.pad ?? 40;
    const xs = p.nodes.map((n) => n.x), ys = p.nodes.map((n) => n.y);
    const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
    const w = Math.max(...xs) - Math.min(...xs) + 2 * pad + (variant === "hero" ? 40 : 110);
    const h = Math.max(...ys) - Math.min(...ys) + 2 * pad + (variant === "studio" ? 110 : 0);
    return [x0, y0, Math.max(w, 1), Math.max(h, 1)];
  }, [p.nodes, p.pad, variant]);
  useEffect(() => setView({ z: 1, tx: 0, ty: 0 }), [p.nodes]);

  // wheel zoom + drag pan
  useEffect(() => {
    const svg = svgRef.current; if (!svg || p.interactive === false) return;
    const toSvg = (cx: number, cy: number) => { const r = svg.getBoundingClientRect(); const s = Math.max(vb[2] / r.width, vb[3] / r.height); return [vb[0] + (cx - r.left - (r.width - vb[2] / s) / 2) * s, vb[1] + (cy - r.top - (r.height - vb[3] / s) / 2) * s, s]; };
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); const [px, py] = toSvg(e.clientX, e.clientY);
      setView((v) => { const nz = Math.min(6, Math.max(0.6, v.z * Math.exp(-e.deltaY * 0.0015))); return { z: nz, tx: px - (px - v.tx) * nz / v.z, ty: py - (py - v.ty) * nz / v.z }; });
    };
    let drag: number[] | null = null;
    const down = (e: PointerEvent) => { if ((e.target as Element).closest("[data-node]")) return; drag = [e.clientX, e.clientY]; svg.setPointerCapture(e.pointerId); wrapRef.current?.classList.add("drag"); };
    const move = (e: PointerEvent) => { if (!drag) return; const s = toSvg(0, 0)[2]; const dx = (e.clientX - drag[0]) * s, dy = (e.clientY - drag[1]) * s; drag = [e.clientX, e.clientY]; setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy })); };
    const up = () => { drag = null; wrapRef.current?.classList.remove("drag"); };
    svg.addEventListener("wheel", wheel, { passive: false }); svg.addEventListener("pointerdown", down); svg.addEventListener("pointermove", move); svg.addEventListener("pointerup", up);
    return () => { svg.removeEventListener("wheel", wheel); svg.removeEventListener("pointerdown", down); svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up); };
  }, [vb, p.interactive]);

  const N = p.nodes;
  const labelSize = variant === "hero" ? 13 : 12;
  const ok = (i: number) => i >= 0 && i < p.nodes.length;
  const routes = (p.routes ?? []).filter((r) => r.path.length > 1 && r.path.every(ok));
  const links = p.links.filter((l) => ok(l.u) && ok(l.v));
  const mstE = (p.mst ?? []).filter((e) => ok(e.u) && ok(e.v));
  const pulses = motion && routes.length <= 120;

  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0 }} onPointerLeave={() => setTip(null)}>
      <svg ref={svgRef} viewBox={vb.join(" ")} preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }} role="img"
        aria-label={`Network map with ${N.length} sites and ${p.links.length} links`}>
        <defs>
          <filter id={`${uid}g`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          <marker id={`${uid}a`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="#EA4335" /></marker>
        </defs>
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.z})`}>
          {links.map((l, k) => {
            const a = N[l.u], b = N[l.v]; const m = p.edgeMark?.[ekey(l.u, l.v)];
            const style = m === "tree" ? { stroke: "#34A853", w: 3.2, o: 0.95 } : m === "path" ? { stroke: "#1A73E8", w: 3.6, o: 1 } : m === "relax" ? { stroke: "#FBBC05", w: 3, o: 1 }
              : m === "consider" ? { stroke: "#1A73E8", w: 2.4, o: 0.9 } : m === "reject" ? { stroke: "#EA4335", w: 1.6, o: 0.6 } : { stroke: "#4285F4", w: 0.6 + Math.log10(l.bandwidth || 10) * 0.5, o: variant === "hero" ? 0.45 : 0.4 };
            return <line key={k} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={style.stroke} strokeOpacity={style.o} strokeWidth={style.w} strokeDasharray={m === "reject" ? "5 4" : undefined} strokeLinecap="round" />;
          })}
          {p.extraArcs?.filter((e) => ok(e.u) && ok(e.v)).map((e, k) => { const a = N[e.u], b = N[e.v]; const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1; const off = 6;
            return <path key={k} d={`M${a.x + (-dy / L) * off} ${a.y + (dx / L) * off} L${b.x + (-dy / L) * off - (dx / L) * 10} ${b.y + (dx / L) * off - (dy / L) * 10}`} stroke="#EA4335" strokeWidth={1.6} strokeDasharray="4 3" fill="none" markerEnd={`url(#${uid}a)`} opacity={0.85} />; })}
          {p.showMst && mstE.map((e, k) => { const a = N[e.u], b = N[e.v]; return <line key={k} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#EA4335" strokeWidth={2.6} strokeOpacity={0.85} strokeLinecap="round" />; })}
          {routes.map((r, k) => <path key={k} id={`${uid}p${k}`} d={pathD(N, r.path)} fill="none" stroke={p.routeColor ? p.routeColor(r) : "#4285F4"} strokeOpacity={0.6} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />)}
          {pulses && routes.map((r, k) => {
            const dur = (0.9 + r.latency_ms * 0.22).toFixed(2) + "s", begin = (-((k * 0.37) % 3)).toFixed(2) + "s", c = p.routeColor ? p.routeColor(r) : "#4285F4";
            return (
              <g key={`pl${k}`}>
                <circle r={7} fill={c} opacity={0.3}><animateMotion dur={dur} begin={begin} repeatCount="indefinite"><mpath href={`#${uid}p${k}`} /></animateMotion></circle>
                <circle r={3.2} fill="#1A73E8"><animateMotion dur={dur} begin={begin} repeatCount="indefinite"><mpath href={`#${uid}p${k}`} /></animateMotion></circle>
              </g>
            );
          })}
          {N.map((n, i) => {
            const host = p.hosts?.[i]; const showHost = !!host && p.showReplicas !== false; const r = nodeR(n);
            const mark = p.nodeMark?.[i]; const dim = p.focusNodes && !p.focusNodes.has(i);
            return (
              <g key={i} transform={`translate(${n.x} ${n.y})`} data-node={i} style={{ cursor: "pointer", opacity: dim ? 0.25 : 1 }}
                onPointerEnter={(e) => { const rr = wrapRef.current!.getBoundingClientRect(); setTip({ i, x: e.clientX - rr.left, y: e.clientY - rr.top }); }}
                onPointerMove={(e) => { const rr = wrapRef.current!.getBoundingClientRect(); setTip({ i, x: e.clientX - rr.left, y: e.clientY - rr.top }); }}
                onPointerLeave={() => setTip(null)}>
                {mark && <circle r={r + 7} fill={mark === "current" ? "#FBBC05" : mark === "source" ? "#1A73E8" : mark === "target" ? "#EA4335" : mark === "settled" ? "#34A853" : "#D3E3FD"} opacity={mark === "frontier" ? 0.9 : 0.35} />}
                {mark === "target" && <circle r={r + 11} fill="none" stroke="#EA4335" strokeWidth={2} strokeDasharray="3 3" />}
                {n.tier === "router"
                  ? <rect x={-3.2} y={-3.2} width={6.4} height={6.4} fill="#9AA0A6" transform="rotate(45)" />
                  : showHost
                    ? <><circle r={r + 5} fill="none" stroke="#FBBC05" strokeOpacity={0.45} /><circle r={r} fill="#FBBC05" stroke="#B06000" strokeWidth={1.2} filter={`url(#${uid}g)`} />
                      {variant !== "hero" && host!.map((j, k) => { const a = -Math.PI / 2 + (k * 2 * Math.PI) / host!.length, rr = r + 9; return <circle key={k} cx={Math.cos(a) * rr} cy={Math.sin(a) * rr} r={3.2} fill={serviceColor(j)} stroke="#fff" strokeWidth={1.2} />; })}</>
                    : <circle r={r} fill={mark === "settled" ? "#34A853" : "#fff"} stroke="#202124" strokeOpacity={0.85} strokeWidth={1.4} />}
                <text x={10} y={4} fontSize={labelSize} fontFamily="Roboto Flex Variable, Roboto Flex, sans-serif" fill={showHost || mark ? "#202124" : "#5F6368"} opacity={showHost || mark ? 0.95 : 0.75}>{shortName(n.name)}</text>
                {p.badges?.[i] != null && <text x={10} y={18} fontSize={11} fontWeight={600} fill="#1A73E8" fontFamily="Roboto Mono, monospace">{p.badges[i]}</text>}
              </g>
            );
          })}
        </g>
      </svg>
      {tip && p.renderTip && (
        <div className="tip" style={{ display: "block", left: Math.min(tip.x + 14, (wrapRef.current?.clientWidth ?? 600) - 240), top: tip.y + 14 }}>{p.renderTip(tip.i)}</div>
      )}
    </div>
  );
}

export function MiniGraph({ nodes, edges }: { nodes: [number, number, string][]; edges: [number, number][] }) {
  const xs = nodes.map((p) => p[0]), ys = nodes.map((p) => p[1]);
  const x0 = Math.min(...xs) - 30, y0 = Math.min(...ys) - 30, w = Math.max(...xs) - x0 + 30, h = Math.max(...ys) - y0 + 30;
  const sw = Math.max(w, h) / 220;
  return (
    <svg viewBox={`${x0} ${y0} ${w} ${h}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {edges.map(([u, v], k) => <line key={k} x1={nodes[u][0]} y1={nodes[u][1]} x2={nodes[v][0]} y2={nodes[v][1]} stroke="#4285F4" strokeOpacity={0.35} strokeWidth={sw} />)}
      {nodes.map((p, k) => <circle key={k} cx={p[0]} cy={p[1]} r={(p[2] === "router" ? 1.4 : p[2] === "core" ? 3 : 2.2) * sw} fill={p[2] === "router" ? "#9AA0A6" : p[2] === "core" ? "#FBBC05" : "#202124"} />)}
    </svg>
  );
}
