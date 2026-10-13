import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useLocation } from "react-router-dom";
import { useApp } from "../lib/app";

/* ---------- "?" button with a popover ---------- */
export function Info({ title, children, label, style, className }: { title: string; children: string; label?: string; style?: React.CSSProperties; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const popRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !ref.current || !popRef.current) return;
    const r = ref.current.getBoundingClientRect(), w = popRef.current.offsetWidth, h = popRef.current.offsetHeight;
    let top = r.bottom + 10; if (top + h > innerHeight - 12) top = r.top - h - 10;
    setPos({ left: Math.min(innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2)), top });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("click", close); addEventListener("keydown", esc); addEventListener("scroll", () => setOpen(false), { once: true });
    return () => { removeEventListener("click", close); removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <>
      <button ref={ref} className={`info ${className ?? ""}`} style={style} aria-label={label ?? `About: ${title}`} aria-expanded={open} onClick={() => setOpen(!open)}>?</button>
      {open && createPortal(<div ref={popRef} className="pop" role="tooltip" style={{ display: "block", left: pos.left, top: pos.top }}><b>{title}</b>{children}</div>, document.body)}
    </>
  );
}

/* ---------- Guided tour ---------- */
interface Step { path: string; sel: string; t: string; x: string }
const TOUR: Step[] = [
  { path: "/", sel: "[data-tour=rail]", t: "Getting around", x: "Use this rail to move between pages. Guide explains everything in more detail, and Motion turns animations on or off." },
  { path: "/", sel: "[data-tour=region]", t: "Pick a region", x: "Switch between India and Nigeria. The map, numbers and default network all follow this choice." },
  { path: "/", sel: "[data-tour=heromap]", t: "The live map", x: "Each moving dot is a user request travelling the fastest path to the nearest copy of its service. Yellow cities host copies." },
  { path: "/", sel: "[data-tour=tiles]", t: "The headline numbers", x: "How fast users are served, how much better that is than a random plan, how close it is to the proven best, and how long it took." },
  { path: "/studio", sel: "[data-tour=controls]", t: "Set up a plan", x: "Choose a network, a budget and the methods to compare." },
  { path: "/studio", sel: "[data-tour=solve]", t: "Solve", x: "Press Solve placement to compute the plan. Everything on the page updates." },
  { path: "/studio", sel: "[data-tour=map]", t: "Explore the plan", x: "See where each service runs. Turn layers on and off at the top, filter by service at the bottom, hover any site for details." },
  { path: "/studio", sel: "[data-tour=tabs]", t: "The details", x: "Tables for routes, server load, cost and benefit, replica sync and batch jobs. Click a route to highlight it on the map." },
  { path: "/studio", sel: "[data-tour=results]", t: "How good is it?", x: "The key numbers, every method compared with the proven best, and plain-language advice." },
  { path: "/lab", sel: "[data-tour=lab]", t: "Watch the algorithms", x: "In the Algorithm lab, pick an algorithm and press play to see it work step by step, with its pseudocode." },
  { path: "/results", sel: "[data-tour=charts]", t: "The experiments", x: "Charts showing how speed and quality change with network size, density, capacity and budget." },
  { path: "/data", sel: "[data-tour=datasets]", t: "The networks", x: "Every network with downloads, plus a generator for new random ones." },
  { path: "/guide", sel: "[data-tour=guide]", t: "You're ready", x: "Come back to the Guide whenever you need it. Panels in the studio and lab also have ? buttons for quick help." },
];

export function Tour() {
  const { tourOn, setTourOn } = useApp();
  const nav = useNavigate(); const loc = useLocation();
  const [i, setI] = useState(0);
  const [box, setBox] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cpos, setCpos] = useState({ left: 0, top: 0 });

  useEffect(() => { if (tourOn) setI(0); }, [tourOn]);
  useEffect(() => { if (tourOn && loc.pathname !== TOUR[i].path) nav(TOUR[i].path); }, [tourOn, i]); // eslint-disable-line react-hooks/exhaustive-deps

  // find the target (it may render a moment after navigation)
  useEffect(() => {
    if (!tourOn) return;
    let tries = 0, raf = 0;
    const find = () => {
      const el = document.querySelector(TOUR[i].sel) as HTMLElement | null;
      if (el && el.getBoundingClientRect().height > 0) { el.scrollIntoView({ block: "center" }); requestAnimationFrame(() => setBox(el.getBoundingClientRect())); return; }
      if (tries++ < 120) raf = requestAnimationFrame(find);
    };
    setBox(null); find();
    const re = () => { const el = document.querySelector(TOUR[i].sel); if (el) setBox(el.getBoundingClientRect()); };
    addEventListener("resize", re); addEventListener("scroll", re, true);
    return () => { cancelAnimationFrame(raf); removeEventListener("resize", re); removeEventListener("scroll", re, true); };
  }, [tourOn, i, loc.pathname]);

  useLayoutEffect(() => {
    if (!box || !cardRef.current) return;
    const cw = cardRef.current.offsetWidth, ch = cardRef.current.offsetHeight; let left: number, top: number;
    if (box.right + 16 + cw < innerWidth) { left = box.right + 16; top = Math.max(12, Math.min(innerHeight - ch - 12, box.top)); }
    else if (box.bottom + 16 + ch < innerHeight) { top = box.bottom + 16; left = Math.max(12, Math.min(innerWidth - cw - 12, box.left)); }
    else if (box.top - 16 - ch > 0) { top = box.top - 16 - ch; left = Math.max(12, Math.min(innerWidth - cw - 12, box.left)); }
    else { left = Math.max(12, box.left - cw - 16); top = Math.max(12, Math.min(innerHeight - ch - 12, box.top)); }
    setCpos({ left, top });
  }, [box, i]);

  useEffect(() => {
    if (!tourOn) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setTourOn(false); if (e.key === "ArrowRight") next(); if (e.key === "ArrowLeft" && i > 0) setI(i - 1); };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const next = () => (i >= TOUR.length - 1 ? setTourOn(false) : setI(i + 1));
  if (!tourOn) return null;
  const st = TOUR[i]; const pad = 8;
  return createPortal(
    <>
      {box ? <div className="tour-hole" style={{ left: box.left - pad, top: box.top - pad, width: box.width + 2 * pad, height: box.height + 2 * pad }} />
        : <div className="tour-hole" style={{ left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 }} />}
      <div ref={cardRef} className="tour-card" role="dialog" aria-label="Site tour" style={{ left: cpos.left, top: cpos.top, visibility: box ? "visible" : "hidden" }}>
        <div className="n">Step {i + 1} of {TOUR.length}</div>
        <h4>{st.t}</h4><p>{st.x}</p>
        <div className="tour-dots">{TOUR.map((_, k) => <i key={k} className={k === i ? "on" : ""} />)}</div>
        <div className="row">
          <button className="skip" onClick={() => setTourOn(false)}>{i === TOUR.length - 1 ? "Close" : "Skip tour"}</button>
          <span style={{ display: "flex", gap: 8 }}>
            {i > 0 && <button className="btn tonal" onClick={() => setI(i - 1)}>Back</button>}
            <button className="btn primary" autoFocus onClick={next}>{i === TOUR.length - 1 ? "Finish" : "Next"}</button>
          </span>
        </div>
      </div>
    </>, document.body);
}

export function TourOffer({ show, onClose }: { show: boolean; onClose: () => void }) {
  const { setTourOn } = useApp();
  return (
    <div className={`snack${show ? " show" : ""}`} role="status">
      <span>New here? Take a 1-minute tour of the site.</span>
      <button className="yes" onClick={() => { onClose(); setTourOn(true); }}>Start tour</button>
      <button className="no" onClick={onClose}>Not now</button>
    </div>
  );
}
