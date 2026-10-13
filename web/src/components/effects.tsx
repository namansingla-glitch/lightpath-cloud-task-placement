import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { startFluid, type Fluid } from "./fluid";
import { useApp } from "../lib/app";

/* ---------- Splash cursor (one global canvas) ---------- */
let fluid: Fluid | null = null;
export function splashBurst(x: number, y: number) { fluid?.burst(x, y); }

export function SplashCanvas({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { motion } = useApp();
  useEffect(() => {
    if (!ref.current || matchMedia("(pointer:coarse)").matches) return;
    try { fluid = startFluid(ref.current); } catch { fluid = null; }
    return () => { fluid?.destroy(); fluid = null; };
  }, []);
  useEffect(() => { fluid?.setActive(active && motion); }, [active, motion]);
  return <canvas id="splash" ref={ref} aria-hidden="true" style={{ display: "none" }} />;
}

/* ---------- SplitText: letters rise in one after another ---------- */
export function SplitText({ text, className, step = 0.022, delay = 0.15, as: Tag = "h1", id, children }:
  { text: string; className?: string; step?: number; delay?: number; as?: any; id?: string; children?: ReactNode }) {
  const words = text.split(" ");
  let i = 0;
  return (
    <Tag className={className} id={id} aria-label={text}>
      {words.map((w, wi) => (
        <Fragment key={wi}>
          <span style={{ whiteSpace: "nowrap" }} aria-hidden="true">
            {[...w].map((c, k) => <span key={k} className="ch" style={{ animationDelay: `${delay + i++ * step}s` }}>{c}</span>)}
          </span>
          {wi < words.length - 1 ? " " : null}
        </Fragment>
      ))}
      {children}
    </Tag>
  );
}

/* ---------- CountUp ---------- */
export function CountUp({ to, decimals = 1, duration = 1300, delay = 0, trigger = 0 }: { to: number; decimals?: number; duration?: number; delay?: number; trigger?: unknown }) {
  const { motion } = useApp();
  const [v, setV] = useState(motion ? 0 : to);
  useEffect(() => {
    if (!motion || !isFinite(to)) { setV(to); return; }
    let raf = 0; const t0 = performance.now() + delay;
    const f = (t: number) => { const k = Math.min(1, Math.max(0, (t - t0) / duration)); setV(to * (1 - Math.pow(1 - k, 3))); if (k < 1) raf = requestAnimationFrame(f); };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, [to, motion, trigger]); // eslint-disable-line react-hooks/exhaustive-deps
  return <span className="num">{isFinite(v) ? v.toFixed(decimals) : "–"}</span>;
}

/* ---------- Glitch text ---------- */
export function Glitch({ text, hoverOnly = false }: { text: string; hoverOnly?: boolean }) {
  return <span className={`glitch${hoverOnly ? " hover-only" : ""}`} data-text={text}>{text}</span>;
}

/* ---------- Scroll velocity: rows that speed up with scroll speed ---------- */
export function ScrollVelocity({ rows }: { rows: string[][] }) {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const { motion } = useApp();
  useEffect(() => {
    let raf = 0, lastY = scrollY, vel = 0, dir = 1; const xs = rows.map(() => 0);
    const tick = () => {
      const dy = scrollY - lastY; lastY = scrollY; vel += (dy - vel) * 0.12; if (Math.abs(dy) > 0.5) dir = Math.sign(dy);
      const boost = 1 + Math.min(12, Math.abs(vel) * 0.35), base = motion ? 0.55 : 0;
      refs.current.forEach((el, i) => {
        if (!el) return; const w = el.scrollWidth / 3; if (!w) return;
        const sgn = i % 2 ? 1 : -1;
        xs[i] = (xs[i] + sgn * base * (i ? 0.8 : 1) * boost * dir) % w; if (xs[i] > 0) xs[i] -= w;
        el.style.transform = `translate3d(${xs[i]}px,0,0)` + (i === 0 && motion ? ` skewX(${Math.max(-12, Math.min(12, -vel * 0.25))}deg)` : "");
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rows, motion]);
  return (
    <section className="velocity" aria-label="Algorithms and live routes">
      {rows.map((items, i) => (
        <div key={i} className={`vrow r${i + 1}`} ref={(el) => (refs.current[i] = el)} aria-hidden={i > 0}>
          {[0, 1, 2].flatMap((rep) => items.map((x, k) => <span key={`${rep}-${k}`}><i className="sep" />{x}</span>))}
        </div>
      ))}
      <span className="velocity-note">Scroll faster and the rows speed up</span>
    </section>
  );
}

/* ---------- Text cursor: labels trail the pointer inside a zone ---------- */
const TC = ["#1A73E8", "#D93025", "#E37400", "#188038"];
/** Section wrapper kept for layout; the old floating-word trail was replaced by the target cursor. */
export function TextCursorZone({ children, className, id }: { words?: string[]; children: ReactNode; className?: string; id?: string }) {
  return <section className={className} id={id}>{children}</section>;
}

/* ---------- Target cursor: a reticle whose corner brackets snap around what you hover ---------- */
const TARGETS = "a,button,[role=button],[role=tab],[role=radio],summary,label[for],.ds,.member,.station,.pill,[data-node],.tiles > div,.algos button,.speeds button,.card.click";
const NO_RETICLE = "input,textarea,select,[contenteditable=true]";
export function TargetCursor() {
  const { motion } = useApp();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current; if (!el) return;
    const fine = matchMedia("(pointer:fine)").matches;
    if (!motion || !fine) { el.style.display = "none"; document.documentElement.classList.remove("tcur"); return; }
    el.style.display = ""; document.documentElement.classList.add("tcur");
    const corners = [...el.querySelectorAll<HTMLElement>(".tc-c")];
    const S = 12, IDLE = 22;                                  // bracket size, idle box size
    let mx = -100, my = -100, x = -100, y = -100, raf = 0, angle = 0, last = performance.now();
    let target: Element | null = null; let hidden = true;
    const cur = corners.map(() => ({ x: 0, y: 0 })), rad = { r: 2 };
    const frame = (t: number) => {
      const dt = Math.min(50, t - last); last = t;
      x += (mx - x) * 0.35; y += (my - y) * 0.35;
      el.style.transform = `translate3d(${x}px,${y}px,0)`;
      let goals: { x: number; y: number }[]; let rot = 0;
      if (target && target.isConnected) {
        const r = target.getBoundingClientRect(), pad = 6;
        const l = r.left - pad - x, tp = r.top - pad - y, rr = r.right + pad - x, b = r.bottom + pad - y;
        goals = [{ x: l, y: tp }, { x: rr - S, y: tp }, { x: rr - S, y: b - S }, { x: l, y: b - S }];
        const br = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0; rad.r = Math.min(10, br / 2.5);
        angle = angle > 180 ? angle + (360 - angle) * 0.3 : angle * 0.7; if (angle < 0.5 || angle > 359.5) angle = 0; rot = angle;
      } else {
        target = null; angle = (angle + dt * 0.09) % 360; rot = angle; rad.r = 2;
        const h = IDLE / 2; goals = [{ x: -h, y: -h }, { x: h - S, y: -h }, { x: h - S, y: h - S }, { x: -h, y: h - S }];
      }
      (el.firstElementChild as HTMLElement).style.transform = `rotate(${rot}deg)`; el.style.setProperty("--cr", rad.r + "px");
      corners.forEach((c, i) => { cur[i].x += (goals[i].x - cur[i].x) * 0.3; cur[i].y += (goals[i].y - cur[i].y) * 0.3; c.style.transform = `translate3d(${cur[i].x}px,${cur[i].y}px,0)`; });
      raf = requestAnimationFrame(frame);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      mx = e.clientX; my = e.clientY;
      if (hidden) { x = mx; y = my; hidden = false; el.classList.remove("off"); }
      const t = e.target as Element | null;
      const plain = t?.closest?.(NO_RETICLE);
      el.classList.toggle("text", !!plain);
      target = plain ? null : t?.closest?.(TARGETS) ?? null;
    };
    const out = (e: PointerEvent) => { if (!e.relatedTarget) { hidden = true; el.classList.add("off"); } };
    const down = () => el.classList.add("press"), up = () => el.classList.remove("press");
    addEventListener("pointermove", move, { passive: true }); document.addEventListener("pointerout", out);
    addEventListener("pointerdown", down); addEventListener("pointerup", up);
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); removeEventListener("pointermove", move); document.removeEventListener("pointerout", out);
      removeEventListener("pointerdown", down); removeEventListener("pointerup", up); document.documentElement.classList.remove("tcur"); };
  }, [motion]);
  return (
    <div ref={root} className="tcursor off" aria-hidden="true">
      <div className="tc-rot"><i className="tc-dot" />{[0, 1, 2, 3].map((k) => <i key={k} className={`tc-c c${k}`} />)}</div>
    </div>
  );
}
