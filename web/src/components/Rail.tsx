import { NavLink, useNavigate } from "react-router-dom";
import { useApp } from "../lib/app";
import { Glitch } from "./effects";

const I = {
  home: <path d="M4 11.5 12 5l8 6.5V20h-5v-5H9v5H4z" strokeLinejoin="round" />,
  studio: <><circle cx="5" cy="17" r="2.2" /><circle cx="12" cy="6" r="2.2" /><circle cx="19" cy="15" r="2.2" /><path d="M6.4 15.3 10.8 7.8M13.6 7.3l4.2 6" /></>,
  lab: <path d="M9 3h6M10 3v6L5 19a1.5 1.5 0 0 0 1.3 2h11.4a1.5 1.5 0 0 0 1.3-2l-5-10V3" strokeLinejoin="round" />,
  results: <path d="M5 20V11M12 20V5M19 20v-7" strokeLinecap="round" />,
  data: <><ellipse cx="12" cy="6" rx="7" ry="2.6" /><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" /></>,
  guide: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6" strokeLinecap="round" /><circle cx="12" cy="16.9" r=".6" fill="currentColor" /></>,
};
const DEST: [string, keyof typeof I, string][] = [["/", "home", "Home"], ["/studio", "studio", "Studio"], ["/lab", "lab", "Lab"], ["/results", "results", "Results"], ["/data", "data", "Data"], ["/guide", "guide", "Guide"]];

export default function Rail() {
  const { mode, motion, setMotion } = useApp();
  const nav = useNavigate();
  return (
    <nav className="rail" aria-label="Main" data-tour="rail">
      <div className="mark" role="button" tabIndex={0} title="Lightpath home" onClick={() => nav("/")} onKeyDown={(e) => e.key === "Enter" && nav("/")}><Glitch text="Lp" hoverOnly /></div>
      <div className="links">
        {DEST.map(([to, ic, label]) => (
          <NavLink key={to} to={to} end={to === "/"} className="dest" style={{ textDecoration: "none" }}>
            <span className="ind"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">{I[ic]}</svg></span>
            {label}
          </NavLink>
        ))}
      </div>
      <div className="spacer" />
      <button className="motion-toggle" aria-pressed={motion} onClick={() => setMotion(!motion)} title="Turn animations on or off">
        <span className="ind" />Motion
      </button>
      <div className="status" title={mode === "live" ? "Connected to the Python API: everything runs live" : "Python API not running: showing saved results"}>
        <i style={{ background: mode === "live" ? "var(--green)" : mode ? "var(--yellow)" : "var(--surface2)" }} />
        {mode === "live" ? "Python API connected" : mode ? "Saved results (offline)" : "Connecting…"}
      </div>
    </nav>
  );
}
