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
export function TextCursorZone({ words, children, className, id }: { words: string[]; children: ReactNode; className?: string; id?: string }) {
  const { motion } = useApp();
  const st = useRef({ last: 0, lx: 0, ly: 0, k: 0 });
  const onMove = (e: React.PointerEvent) => {
    if (!motion || e.pointerType !== "mouse" || !words.length) return;
    const s = st.current; const now = performance.now(), d = Math.hypot(e.clientX - s.lx, e.clientY - s.ly);
    if (now - s.last < 45 || d < 18) return; s.last = now; s.lx = e.clientX; s.ly = e.clientY;
    const el = document.createElement("span"); el.className = "tc-item"; el.textContent = words[s.k % words.length]; el.style.color = TC[s.k % 4]; s.k++;
    el.style.left = e.clientX + "px"; el.style.top = e.clientY + "px"; document.body.appendChild(el);
    const dx = (Math.random() - 0.5) * 60, dy = -20 - Math.random() * 40, rot = (Math.random() - 0.5) * 30;
    el.animate([{ opacity: 0, transform: "translate(-50%,-50%) scale(.6)" }, { opacity: 1, transform: "translate(-50%,-50%) scale(1)", offset: 0.15 },
      { opacity: 0, transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.9) rotate(${rot}deg)` }], { duration: 1300, easing: "cubic-bezier(.2,.7,.2,1)" }).onfinish = () => el.remove();
  };
  return <section className={`${className ?? ""} tc-zone`} id={id} onPointerMove={onMove}>{children}</section>;
}
