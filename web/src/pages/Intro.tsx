import { useEffect, useRef, useState } from "react";
import { Glitch, splashBurst } from "../components/effects";
import { useApp } from "../lib/app";

const TEAM = [
  { ini: "NS", name: "Naman Singla", role: "Built the platform", what: "Graph algorithms, placement solver, experiments, API and this website.", bg: "var(--primary)", chip: ["var(--tone)", "var(--on-tone)"] },
  { ini: "MG", name: "Mohak Gupta", role: "Research and front end", what: "The research report and the front-end foundations.", bg: "var(--red)", chip: ["#FCE8E6", "#A50E0E"] },
  { ini: "MA", name: "Dr. Monday Jubrin Abdullahi", role: "Guided by", what: "Faculty guide for the project.", bg: "var(--green)", chip: ["#E6F4EA", "#0D652D"], guide: true },
];

/** Big title: letters rise in, a four-colour light beam sweeps through, and letters near the pointer get heavier and wider. */
function PressureTitle() {
  const { motion } = useApp();
  const ref = useRef<HTMLHeadingElement>(null);
  const letters = [..."Lightpath"];
  useEffect(() => {
    const t = ref.current; if (!t || !motion || !matchMedia("(pointer:fine)").matches) return;
    const chars = [...t.querySelectorAll<HTMLElement>(".ch")]; const cur = chars.map(() => ({ w: 600, d: 100 }));
    let px = -1e4, py = -1e4, raf = 0;
    const frame = () => {
      raf = 0; let moving = false; const rad = Math.max(220, t.getBoundingClientRect().height * 1.6);
      chars.forEach((c, k) => {
        const r = c.getBoundingClientRect(); const d = Math.hypot(px - (r.left + r.width / 2), py - (r.top + r.height / 2));
        const f = Math.max(0, 1 - d / rad), e = f * f * (3 - 2 * f), tw = 600 + e * 350, td = 100 + e * 25;
        cur[k].w += (tw - cur[k].w) * 0.25; cur[k].d += (td - cur[k].d) * 0.25;
        if (Math.abs(tw - cur[k].w) > 0.5 || Math.abs(td - cur[k].d) > 0.2) moving = true;
        c.style.fontVariationSettings = `"wght" ${cur[k].w.toFixed(0)},"wdth" ${cur[k].d.toFixed(1)},"opsz" 144`;
      });
      if (moving) raf = requestAnimationFrame(frame);
    };
    const mv = (e: PointerEvent) => { px = e.clientX; py = e.clientY; if (!raf) raf = requestAnimationFrame(frame); };
    const lv = () => { px = py = -1e4; if (!raf) raf = requestAnimationFrame(frame); };
    addEventListener("pointermove", mv); document.addEventListener("pointerleave", lv);
    return () => { removeEventListener("pointermove", mv); document.removeEventListener("pointerleave", lv); cancelAnimationFrame(raf); };
  }, [motion]);
  return (
    <h1 className="intro-title" ref={ref} aria-label="Lightpath">
      {letters.map((c, i) => <span key={i} className="ch" aria-hidden="true" style={{ animationDelay: `${0.1 + i * 0.045}s, ${1.4 + i * 0.11}s` }}>{c}</span>)}
      <span className="ch dot" aria-hidden="true" style={{ animationDelay: `${0.1 + letters.length * 0.045}s, ${1.3 + letters.length * 0.045}s` }}>.</span>
      
    </h1>
  );
}

export default function Intro({ onEnter }: { onEnter: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const enter = () => {
    if (leaving) return;
    const b = btn.current?.getBoundingClientRect(); if (b) splashBurst(b.left + b.width / 2, b.top + b.height / 2);
    setLeaving(true); setTimeout(onEnter, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 650);
  };
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Enter" && enter(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); });
  return (
    <section className={`intro${leaving ? " leaving" : ""}`} style={{ display: "flex" }} aria-label="Welcome">
      <div className="intro-top">
        <div className="intro-brand"><div className="mark"><Glitch text="Lp" hoverOnly /></div>Lightpath</div>
        <span className="chip-k"><span className="dots"><i style={{ background: "var(--blue)" }} /><i style={{ background: "var(--red)" }} /><i style={{ background: "var(--yellow)" }} /><i style={{ background: "var(--green)" }} /></span>Woxsen University</span>
      </div>
      <div className="intro-main">
        <span className="chip-k" style={{ alignSelf: "flex-start" }}>Cloud task placement on network graphs</span>
        <PressureTitle />
        <p className="intro-sub">Servers become nodes, fibre links become weighted edges, and shortest paths, spanning trees and knapsack dynamic programming decide where every workload runs.</p>
        <div className="team-h">The team</div>
        <div className="team">
          {TEAM.map((m) => (
            <div key={m.name} className={`member${m.guide ? " mentor" : ""}`}>
              <div className="avatar" style={{ background: m.bg }}>{m.ini}</div>
              <div><div className="who">{m.name}</div><span className="role" style={{ background: m.chip[0], color: m.chip[1] }}>{m.role}</span><p className="what">{m.what}</p></div>
            </div>
          ))}
        </div>
        <div className="intro-cta">
          <button ref={btn} className="btn primary" onClick={enter}>Enter Lightpath</button>
          <span className="hint">or press <kbd>Enter</kbd></span>
        </div>
      </div>
    </section>
  );
}
