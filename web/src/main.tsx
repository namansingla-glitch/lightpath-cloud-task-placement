import { StrictMode, useEffect, useState, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes, useLocation } from "react-router-dom";
import "@fontsource-variable/roboto-flex/full.css";
import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/500.css";
import "./styles/base.css";
import "./styles/app.css";
import { AppProvider, useApp } from "./lib/app";
import Rail from "./components/Rail";
import { TargetCursor } from "./components/effects";
import { Tour, TourOffer } from "./components/Help";
import Intro from "./pages/Intro";
import Home from "./pages/Home";
import Studio from "./pages/Studio";
import Lab from "./pages/Lab";
import Data from "./pages/Data";
import Guide from "./pages/Guide";

const Results = lazy(() => import("./pages/Results")); // charts library only loads on this page

function Shell() {
  const loc = useLocation();
  const { motion } = useApp();
  const [intro, setIntro] = useState(() => { try { return !sessionStorage.getItem("lp.entered") && loc.pathname === "/"; } catch { return loc.pathname === "/"; } });
  const [offer, setOffer] = useState(false);
  const [entering, setEntering] = useState(false);
  useEffect(() => { document.body.classList.toggle("intro-on", intro); }, [intro]);
  useEffect(() => { if (!intro) window.scrollTo(0, 0); }, [loc.pathname, intro]);
  useEffect(() => {
    const names: Record<string, string> = { "/": "Home", "/studio": "Placement studio", "/lab": "Algorithm lab", "/results": "Results", "/data": "Data", "/guide": "Guide" };
    document.title = intro ? "Lightpath" : `${names[loc.pathname] ?? "Lightpath"} · Lightpath`;
  }, [loc.pathname, intro]);

  const enter = () => {
    try { sessionStorage.setItem("lp.entered", "1"); } catch { /* ignore */ }
    setIntro(false); setEntering(true); setTimeout(() => setEntering(false), 900);
    let seen = false; try { seen = !!localStorage.getItem("lp.toured"); } catch { /* ignore */ }
    if (!seen) setTimeout(() => setOffer(true), 1400);
  };
  const closeOffer = () => { setOffer(false); try { localStorage.setItem("lp.toured", "1"); } catch { /* ignore */ } };

  return (
    <>
      <TargetCursor />
      {intro ? <Intro onEnter={enter} /> : (
        <>
          <Rail />
          <div className={`page${entering && motion ? " entering" : ""}`}>
            <Suspense fallback={<div className="loading"><div><div className="spin" />Loading</div></div>}>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/studio" element={<Studio />} />
                <Route path="/lab" element={<Lab />} />
                <Route path="/results" element={<Results />} />
                <Route path="/data" element={<Data />} />
                <Route path="/guide" element={<Guide />} />
                <Route path="*" element={<Home />} />
              </Routes>
            </Suspense>
          </div>
          <TourOffer show={offer} onClose={closeOffer} />
          <Tour />
        </>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <AppProvider>
        <Shell />
      </AppProvider>
    </HashRouter>
  </StrictMode>,
);
