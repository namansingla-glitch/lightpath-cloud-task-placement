import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../lib/app";

const SECTIONS: [string, string][] = [["g-start", "Start here"], ["g-pages", "What each page does"], ["g-studio", "Using the studio"], ["g-results", "Reading the results"], ["g-run", "Running it yourself"], ["g-terms", "Words used on the site"]];

const PAGES: { name: string; path?: string; does: string; how: string[] }[] = [
  { name: "Landing", does: "The first screen. It names the project and the people behind it.", how: ["Press \"Enter Lightpath\" or the Enter key to go to the site."] },
  { name: "Home", path: "/", does: "A one-page overview of the project, with a live map of the selected region.", how: ["Switch between India and Nigeria at the top.", "Each moving dot on the map is a user request travelling the fastest path to the nearest copy of its service.", "The four tiles summarise the best plan found.", "Click any network card at the bottom to open it in the studio."] },
  { name: "Placement studio", path: "/studio", does: "Where you run the planner and explore its answer.", how: ["Set the controls on the left, then press \"Solve placement\".", "Explore the plan on the map and in the tabs underneath.", "Click a bar in the strategy chart to see that method's placement on the map."] },
  { name: "Algorithm lab", path: "/lab", does: "Watch each algorithm work, one step at a time, on a real network.", how: ["Pick an algorithm, a network, a start city and a destination.", "Press play, or step forward and back, and follow the highlighted line of pseudocode. Choose 0.5×, 1×, 1.5×, 2× or 4× speed.", "Dijkstra and Prim stop as soon as the destination's route is final; press Run to the end to see the rest.", "When it finishes, the route is drawn in blue and listed hop by hop with its delay.", "Open Compare two algorithms to run two on the same trip side by side and see which one suits it best.", "Floyd–Warshall and Johnson show the full distance table as a colour map, with your start → destination cell outlined."] },
  { name: "Results", path: "/results", does: "Charts from the eight experiments: how speed and quality change as networks grow, get denser, run short of capacity or get more budget.", how: ["Hover any point to see its exact value; use the small switches to change view.", "Each chart has a one-line takeaway and links to its data and report figure."] },
  { name: "Data", path: "/data", does: "Every network used in the project, with downloads and a generator.", how: ["Download a network as JSON or Gephi, or its plan as CSV tables.", "Generate a new random network and open it in the studio."] },
];
const T = (rows: [string, string][]) => <div className="ctl">{rows.flatMap(([a, b]) => [<div key={a + "a"}>{a}</div>, <div key={a + "b"}>{b}</div>])}</div>;

export default function Guide() {
  const nav = useNavigate();
  const { setTourOn } = useApp();
  const [on, setOn] = useState("g-start");
  useEffect(() => {
    const f = () => { let cur = SECTIONS[0][0]; for (const [id] of SECTIONS) { const el = document.getElementById(id); if (el && el.getBoundingClientRect().top < 160) cur = id; } setOn(cur); };
    addEventListener("scroll", f); return () => removeEventListener("scroll", f);
  }, []);
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });

  return (
    <main className="guide">
      <nav className="toc" aria-label="Guide sections">
        {SECTIONS.map(([id, l]) => <a key={id} href={`#${id}`} className={on === id ? "on" : ""} onClick={(e) => { e.preventDefault(); go(id); }}>{l}</a>)}
        <button className="btn primary" onClick={() => setTourOn(true)}>Take the 1-minute tour</button>
      </nav>
      <div className="gbody" data-tour="guide">
        <h1>How to use Lightpath</h1>
        <p className="lead">Lightpath decides where to run copies of online services on a network of servers, so that users get answers as fast as possible without overloading any server or going over budget. You do not need to know the algorithms to use it.</p>

        <section className="gsec" id="g-start"><h2>Start here</h2><p>Four steps get you from nothing to a full placement plan.</p>
          <ol className="steps">
            <li><b>Pick a region</b>Choose India or Nigeria with the switch at the top of Home. The studio and lab start on that region.</li>
            <li><b>Open the studio</b>Press "Open the placement studio", or Studio in the left rail.</li>
            <li><b>Set it up and solve</b>Choose a network, set a budget, and press "Solve placement".</li>
            <li><b>Read the plan</b>The map shows where each service runs, the right panel shows how good the plan is, and the tabs give the details.</li>
          </ol></section>

        <section className="gsec" id="g-pages"><h2>What each page does</h2>
          <div className="pagecards">{PAGES.map((p) => (
            <div key={p.name} className="pc"><h3>{p.name}</h3><p className="does">{p.does}</p>
              <div className="how">How to use it</div><ul>{p.how.map((h) => <li key={h}>{h}</li>)}</ul>
              {p.path && <button className="btn tonal go" onClick={() => nav(p.path!)}>Open {p.name}</button>}</div>))}</div></section>

        <section className="gsec" id="g-studio"><h2>Using the studio</h2>
          <p>The studio has three parts: controls on the left, the map with its tabs in the middle, and the results on the right. Every panel has a small "?" button that explains it on the spot.</p>
          <div className="ctl-h">Controls</div>
          {T([["Network", "Which network to plan for: India, Nigeria, the Woxsen campus, one of the test networks, or one you generated."],
            ["VM budget", "Dollars per hour you can spend on copies of services. More budget buys more copies, which brings services closer to users, but each extra copy helps less than the one before."],
            ["Server budget", "Optional. Limits which servers are switched on, picking the most useful ones that fit the budget (0/1 knapsack)."],
            ["Replica sizing", "How many copies each service gets. \"Knapsack DP\" finds the best mix for your budget; \"Minimum\" and \"Maximum\" are for comparison."],
            ["Strategies", "The placement methods to compare. \"Local search refinement\" improves each method's answer. \"Exact MILP check\" computes the true best answer on small networks so you can see how close the fast methods get."],
            ["Solve placement", "Runs everything and refreshes the map, tabs and results."]])}
          <div className="ctl-h">Map</div>
          {T([["Backbone (MST)", "Shows, in red, the cheapest set of links that still connects every site."], ["Replicas", "Yellow sites host copies of services; the small coloured dots around them say which services."],
            ["Routes", "The path each group of users takes to reach its nearest copy."], ["Service chips", "Click a service to show only its copies and routes. \"All services\" shows everything."],
            ["Moving around", "Scroll to zoom, drag to move, and hover any site to see its load and what runs there."]])}
          <div className="ctl-h">Tabs under the map</div>
          {T([["Routes", "Who is served from where, along which path, and how fast. Click a row to highlight that route on the map."], ["Servers", "How full each server is. Red bars are nearly full; extra capacity there would help most."],
            ["Cost and benefit", "Average delay for each number of copies of each service, the option the budget bought in blue, and what the next copy would save."],
            ["Replica sync", "How copies of the same service keep each other up to date: the fastest path versus the cheapest path, which can use links that pay a rebate."],
            ["Batch jobs", "A timeline of background jobs on each server. The red dashed line marks when the last one finishes."],
            ["Server activation", "Appears when a server budget is set: which servers the knapsack kept on."]])}</section>

        <section className="gsec" id="g-results"><h2>Reading the results</h2>
          {T([["Average latency", "How long a typical request waits for the network, in milliseconds. Lower is better."], ["95th percentile", "95 out of 100 requests are at least this fast. It shows how the slowest users fare."],
            ["VM cost", "What the plan costs per hour."], ["Full pipeline", "How long the computer took to produce the whole plan."],
            ["Strategy chart", "One bar per method; shorter is better. The dashed green line is the proven best answer, so a bar touching it is optimal."],
            ["Recommendations", "The plan explained in plain sentences, including where one more dollar or one more server would help most."]])}</section>

        <section className="gsec" id="g-run"><h2>Running it yourself</h2>
          <p>The bottom of the left rail shows whether the site is connected to the Python engine. Connected, everything runs live. Not connected, the site shows saved results computed with the default settings, and the controls that need the engine are switched off.</p>
          {T([["Start everything", "In the project folder run ./run.sh (Mac or Linux). It installs what is needed, builds the site and opens it at http://localhost:8000."],
            ["Motion", "The Motion switch at the bottom of the rail turns the animations (ink, moving text, pulses) on or off. The site follows your system's reduced-motion setting by default."]])}</section>

        <section className="gsec" id="g-terms"><h2>Words used on the site</h2>
          <div className="gloss">{([
            ["Latency", "The delay before data arrives, in milliseconds (ms). 1 ms is a thousandth of a second."], ["Node and link", "A node is a site such as a city, data centre or campus building. A link is the cable between two sites."],
            ["Replica", "A copy of a service running on a server. More copies in more places means shorter trips for users."], ["Capacity", "How much processing power (CPU) and memory a server has. Copies cannot exceed it."],
            ["Shortest path", "The fastest route between two sites through the network (Dijkstra, Bellman-Ford, Floyd–Warshall, Johnson)."], ["Spanning tree (MST)", "The cheapest set of links that keeps every site connected (Prim, Kruskal)."],
            ["Knapsack DP", "A method that picks the best combination of options that fits within a budget."], ["Greedy method", "A fast method that makes the best-looking choice at each step."],
            ["Local search", "Takes a plan and keeps making small swaps while they improve it."], ["Exact optimum (MILP)", "The provably best plan. Slow on big networks, so it is used as a reference on small ones."],
            ["Gap", "How far a method's plan is from the proven best, in percent. 0% means optimal."], ["Rebate link", "A link that pays you to send data over it (a negative cost), which is why some routes need Bellman-Ford or Johnson."],
          ] as [string, string][]).map(([a, b]) => <div key={a}><b>{a}</b>{b}</div>)}</div></section>
      </div>
    </main>
  );
}
