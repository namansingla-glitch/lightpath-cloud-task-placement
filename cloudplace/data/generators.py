"""Synthetic topology + workload generators.

Latency model: propagation in fibre ≈ 200 km/ms with a 1.3 route-inflation
factor, plus 0.3 ms switching per hop:  l(u,v) = 1.3·dist_km/200 + 0.3.

Server tiers (by degree centrality): core / regional / edge, plus pure routers
(cpu = 0) that forward traffic but cannot host.  ``capacity_factor`` scales
every server, which is how the experiments tighten or relax capacity.
"""
from __future__ import annotations

import math
import random
from typing import Any

from ..core.graph import Graph
from ..core.unionfind import UnionFind
from ..model.instance import BatchTask, Instance, Service

TIERS = {
    #          cpu  mem  $/h
    "core":     (48, 192, 1.90),
    "regional": (24, 96, 0.95),
    "edge":     (8, 48, 0.32),
    "router":   (0, 0, 0.0),
}

SERVICE_CATALOG = [
    ("web-frontend", 4, 8), ("auth", 2, 4), ("search", 8, 32), ("video-transcode", 16, 32),
    ("ml-inference", 8, 64), ("cache", 4, 32), ("payments", 4, 8), ("analytics", 16, 64),
    ("chat", 2, 4), ("cdn-edge", 4, 16), ("db-replica", 8, 64), ("notifications", 2, 4),
    ("maps", 4, 16), ("recommendations", 8, 32), ("iot-ingest", 4, 8), ("logging", 2, 8),
]
PALETTE = ["#7c5cff", "#22d3ee", "#f472b6", "#facc15", "#34d399", "#fb923c", "#60a5fa", "#e879f9",
           "#a3e635", "#f87171", "#2dd4bf", "#c084fc", "#fbbf24", "#38bdf8", "#4ade80", "#f9a8d4"]


def latency_from_km(km: float) -> float:
    return round(1.3 * km / 200.0 + 0.3, 3)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _dist(g: Graph, u: int, v: int, region_km: float) -> float:
    a, b = g.nodes[u], g.nodes[v]
    if "lat" in a and "lat" in b:
        return haversine_km(a["lat"], a["lon"], b["lat"], b["lon"])
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"]) / 1000.0 * region_km


def _link(g: Graph, u: int, v: int, region_km: float, rng: random.Random, bw: float | None = None) -> None:
    km = _dist(g, u, v, region_km)
    g.add_edge(u, v, latency=latency_from_km(km), bandwidth=bw or rng.choice([10, 40, 100]),
               km=round(km, 1))


def connect_components(g: Graph, region_km: float, rng: random.Random) -> int:
    """Join components with their geographically shortest bridging link."""
    added = 0
    while True:
        comps = g.components()
        if len(comps) <= 1:
            return added
        main, other = comps[0], comps[1]
        u, v = min(((a, b) for a in main for b in other), key=lambda ab: _dist(g, ab[0], ab[1], region_km))
        _link(g, u, v, region_km, rng)
        added += 1


def assign_tiers(g: Graph, rng: random.Random, capacity_factor: float = 1.0,
                 router_frac: float = 0.15, core_frac: float = 0.1, regional_frac: float = 0.3) -> None:
    order = sorted(range(g.n), key=lambda u: -g.degree(u))
    n = g.n
    n_core = max(1, round(core_frac * n))
    n_reg = max(1, round(regional_frac * n))
    routers = set(rng.sample(order[n_core:], k=min(int(router_frac * n), max(0, n - n_core))))
    for rank, u in enumerate(order):
        if rank < n_core:
            tier = "core"
        elif u in routers:
            tier = "router"
        elif rank < n_core + n_reg:
            tier = "regional"
        else:
            tier = "edge"
        cpu, mem, cost = TIERS[tier]
        g.nodes[u].update(tier=tier, cpu=round(cpu * capacity_factor), mem=round(mem * capacity_factor),
                          cost=cost)


def add_rebates(g: Graph, rng: random.Random, frac: float = 0.08) -> None:
    edges = list(g.edges())
    for e in rng.sample(edges, k=max(1, int(frac * len(edges)))) if edges else []:
        a, b = (e.u, e.v) if rng.random() < 0.5 else (e.v, e.u)
        reb = round(rng.uniform(0.005, 0.02), 4)
        for x, y in ((e.u, e.v), (e.v, e.u)):
            g.adj[x][y].attrs.update(rebate=reb, rebate_dir=[a, b])


# --------------------------------------------------------------- topologies
def _place_nodes(g: Graph, n: int, rng: random.Random, prefix: str = "dc") -> None:
    for i in range(n):
        g.add_node(name=f"{prefix}-{i:03d}", x=round(rng.uniform(20, 980), 1), y=round(rng.uniform(20, 980), 1))


def waxman(n: int, alpha: float = 0.4, beta: float = 0.12, seed: int = 0,
           region_km: float = 3000.0) -> Graph:
    """Waxman (1988): P(u~v) = alpha · exp(-d / (beta · L)). Geographic, realistic WAN."""
    rng = random.Random(seed)
    g = Graph()
    _place_nodes(g, n, rng)
    L = math.sqrt(2) * 1000
    for u in range(n):
        for v in range(u + 1, n):
            d = math.hypot(g.nodes[u]["x"] - g.nodes[v]["x"], g.nodes[u]["y"] - g.nodes[v]["y"])
            if rng.random() < alpha * math.exp(-d / (beta * L)):
                _link(g, u, v, region_km, rng)
    connect_components(g, region_km, rng)
    return g


def erdos_renyi(n: int, p: float, seed: int = 0, region_km: float = 3000.0) -> Graph:
    """G(n,p) on random positions; a random spanning tree is added first so it is connected."""
    rng = random.Random(seed)
    g = Graph()
    _place_nodes(g, n, rng)
    perm = list(range(n))
    rng.shuffle(perm)
    for i in range(1, n):  # random tree guarantees connectivity
        _link(g, perm[i], perm[rng.randrange(i)], region_km, rng)
    for u in range(n):
        for v in range(u + 1, n):
            if not g.has_edge(u, v) and rng.random() < p:
                _link(g, u, v, region_km, rng)
    return g


def barabasi_albert(n: int, m: int = 2, seed: int = 0, region_km: float = 3000.0) -> Graph:
    """Preferential attachment: scale-free degree distribution (hub-and-spoke ISPs)."""
    rng = random.Random(seed)
    g = Graph()
    _place_nodes(g, n, rng)
    m = max(1, min(m, n - 1))
    targets = list(range(m))
    repeated: list[int] = []
    for u in range(m, n):
        for v in set(targets):
            _link(g, u, v, region_km, rng)
        repeated.extend(targets)
        repeated.extend([u] * m)
        targets = []
        while len(set(targets)) < m:
            targets.append(rng.choice(repeated))
        targets = list(set(targets))
    connect_components(g, region_km, rng)
    return g


def fat_tree(k: int = 4, seed: int = 0) -> Graph:
    """k-ary fat-tree data centre (Al-Fares et al. 2008): (k/2)^2 core, k pods."""
    if k % 2:
        raise ValueError("k must be even")
    rng = random.Random(seed)
    g = Graph()
    h = k // 2
    core = []
    for i in range(h * h):
        core.append(g.add_node(name=f"core-{i}", tier="router", cpu=0, mem=0, cost=0.0,
                               x=round(100 + 800 * (i + 0.5) / (h * h), 1), y=80.0))
    hosts = []
    for p in range(k):
        px = 1000 * (p + 0.5) / k
        aggs = [g.add_node(name=f"agg-{p}-{a}", tier="router", cpu=0, mem=0, cost=0.0,
                           x=round(px - 60 + 120 * a / max(h - 1, 1), 1), y=330.0) for a in range(h)]
        edges = [g.add_node(name=f"tor-{p}-{e}", tier="router", cpu=0, mem=0, cost=0.0,
                            x=round(px - 60 + 120 * e / max(h - 1, 1), 1), y=580.0) for e in range(h)]
        for a_i, a in enumerate(aggs):
            for c in range(h):
                g.add_edge(a, core[a_i * h + c], latency=0.02, bandwidth=100)
            for e in edges:
                g.add_edge(a, e, latency=0.01, bandwidth=40)
        for e_i, e in enumerate(edges):
            for hh in range(h):
                tier = rng.choice(["regional", "edge", "edge"])
                cpu, mem, cost = TIERS[tier]
                s = g.add_node(name=f"host-{p}-{e_i}-{hh}", tier=tier, cpu=cpu, mem=mem, cost=cost,
                               x=round(px - 90 + 180 * (e_i * h + hh) / max(h * h - 1, 1), 1), y=850.0)
                g.add_edge(s, e, latency=0.005, bandwidth=10)
                hosts.append(s)
    return g


# ------------------------------------------------------------- real-world
ABILENE = {  # Internet2 Abilene backbone (2004): 11 PoPs, 14 links
    "nodes": [("Seattle", 47.61, -122.33), ("Sunnyvale", 37.37, -122.04), ("Los Angeles", 34.05, -118.24),
              ("Denver", 39.74, -104.99), ("Kansas City", 39.10, -94.58), ("Houston", 29.76, -95.37),
              ("Chicago", 41.88, -87.63), ("Indianapolis", 39.77, -86.16), ("Atlanta", 33.75, -84.39),
              ("Washington DC", 38.91, -77.04), ("New York", 40.71, -74.01)],
    "links": [(0, 1), (0, 3), (1, 2), (1, 3), (2, 5), (3, 4), (4, 5), (4, 7), (5, 8), (7, 6), (7, 8),
              (6, 10), (8, 9), (10, 9)],
}

NSFNET = {  # NSFNET T1 backbone (14 nodes, 21 links) as used in optical-network studies
    "nodes": [("Seattle", 47.61, -122.33), ("Palo Alto", 37.44, -122.14), ("San Diego", 32.72, -117.16),
              ("Salt Lake City", 40.76, -111.89), ("Boulder", 40.01, -105.27), ("Houston", 29.76, -95.37),
              ("Lincoln", 40.81, -96.70), ("Champaign", 40.12, -88.24), ("Pittsburgh", 40.44, -79.99),
              ("Atlanta", 33.75, -84.39), ("Ann Arbor", 42.28, -83.74), ("Ithaca", 42.44, -76.50),
              ("Princeton", 40.35, -74.66), ("College Park", 38.99, -76.94)],
    "links": [(0, 1), (0, 2), (0, 7), (1, 2), (1, 3), (2, 5), (3, 4), (3, 10), (4, 5), (4, 6), (5, 9),
              (5, 13), (6, 7), (7, 8), (8, 9), (8, 11), (8, 12), (10, 11), (10, 12), (11, 13), (12, 13)],
}

INDIA_CITIES = [  # major Indian metros (real coordinates); links synthesised geographically
    ("Mumbai", 19.08, 72.88), ("Delhi", 28.61, 77.21), ("Bengaluru", 12.97, 77.59), ("Chennai", 13.08, 80.27),
    ("Hyderabad", 17.39, 78.49), ("Kolkata", 22.57, 88.36), ("Pune", 18.52, 73.86), ("Ahmedabad", 23.02, 72.57),
    ("Jaipur", 26.91, 75.79), ("Lucknow", 26.85, 80.95), ("Kochi", 9.93, 76.27), ("Bhubaneswar", 20.30, 85.82),
    ("Nagpur", 21.15, 79.09), ("Guwahati", 26.14, 91.74), ("Chandigarh", 30.73, 76.78), ("Indore", 22.72, 75.86),
    ("Patna", 25.59, 85.14), ("Visakhapatnam", 17.69, 83.22), ("Coimbatore", 11.02, 76.96), ("Bhopal", 23.26, 77.41),
    ("Srinagar", 34.08, 74.80), ("Goa", 15.50, 73.83), ("Raipur", 21.25, 81.63), ("Varanasi", 25.32, 82.97),
    ("Woxsen University", 17.62, 77.94),  # Kamkole, Sangareddy district, Telangana (approximate)
]


def _project(g: Graph) -> None:
    lats = [a["lat"] for a in g.nodes]
    lons = [a["lon"] for a in g.nodes]
    la0, la1, lo0, lo1 = min(lats), max(lats), min(lons), max(lons)
    span = max(la1 - la0, (lo1 - lo0) * math.cos(math.radians((la0 + la1) / 2)), 1e-6)
    for a in g.nodes:
        a["x"] = round(60 + 880 * (a["lon"] - lo0) * math.cos(math.radians((la0 + la1) / 2)) / span, 1)
        a["y"] = round(60 + 880 * (la1 - a["lat"]) / span, 1)


def from_cities(cities: list[tuple[str, float, float]], links: list[tuple[int, int]] | None,
                k_nearest: int = 3, seed: int = 0) -> Graph:
    rng = random.Random(seed)
    g = Graph()
    for name, lat, lon in cities:
        g.add_node(name=name, lat=lat, lon=lon)
    _project(g)
    if links is not None:
        for u, v in links:
            _link(g, u, v, 0, rng, bw=rng.choice([10, 40, 100]))
    else:
        for u in range(g.n):
            near = sorted((v for v in range(g.n) if v != u), key=lambda v: _dist(g, u, v, 0))[:k_nearest]
            for v in near:
                if not g.has_edge(u, v):
                    _link(g, u, v, 0, rng)
        connect_components(g, 0, rng)
    return g


WOXSEN_SITES = [
    # name, tier, x, y   (positions traced from the Woxsen University campus map, west to east)
    ("Main Entrance (ISP uplink)", "router", 70, 470),
    ("Parking", "router", 235, 400),
    ("Amphitheatre", "router", 350, 330),
    ("Academic Block (Data Centre A)", "core", 470, 345),
    ("Bloomberg Finance Lab", "edge", 430, 400),
    ("AI & Robotics Studio", "regional", 505, 405),
    ("Admin Block / Gateway (Data Centre B)", "core", 465, 520),
    ("Rise Café", "router", 410, 560),
    ("Trade Tower", "regional", 520, 485),
    ("Central Library (Vithal Gandhi Centre)", "regional", 535, 330),
    ("Cup of Joe Café", "router", 580, 355),
    ("Ink & Water (Tuck Shop)", "router", 525, 250),
    ("Care & Cure (Medical Facility)", "edge", 585, 270),
    ("Hostel Tower", "regional", 690, 230),
    ("Oval Dining Hall", "router", 770, 300),
    ("The League (Sports Arena)", "edge", 800, 240),
    ("SportX", "router", 815, 330),
    ("Swimming Pool & Blue Embers", "router", 850, 210),
    ("ICC Cricket Ground", "router", 930, 300),
    ("Student Hostel A", "edge", 790, 420),
    ("Student Hostel B", "edge", 840, 445),
    ("Student Hostel C", "edge", 895, 465),
    ("Student Hostel D", "edge", 950, 485),
]
WOXSEN_FIBRE = [  # (a, b, Gbit/s)
    ("Main Entrance (ISP uplink)", "Parking", 40), ("Parking", "Amphitheatre", 40),
    ("Amphitheatre", "Academic Block (Data Centre A)", 40),
    ("Main Entrance (ISP uplink)", "Admin Block / Gateway (Data Centre B)", 40),
    ("Academic Block (Data Centre A)", "Admin Block / Gateway (Data Centre B)", 100),
    ("Academic Block (Data Centre A)", "Bloomberg Finance Lab", 10),
    ("Academic Block (Data Centre A)", "AI & Robotics Studio", 40),
    ("Academic Block (Data Centre A)", "Central Library (Vithal Gandhi Centre)", 40),
    ("Admin Block / Gateway (Data Centre B)", "Rise Café", 1),
    ("Admin Block / Gateway (Data Centre B)", "Trade Tower", 40),
    ("Trade Tower", "AI & Robotics Studio", 10),
    ("Central Library (Vithal Gandhi Centre)", "Cup of Joe Café", 1),
    ("Central Library (Vithal Gandhi Centre)", "Ink & Water (Tuck Shop)", 10),
    ("Ink & Water (Tuck Shop)", "Care & Cure (Medical Facility)", 10),
    ("Central Library (Vithal Gandhi Centre)", "Hostel Tower", 40),
    ("Care & Cure (Medical Facility)", "Hostel Tower", 10),
    ("Hostel Tower", "Oval Dining Hall", 10), ("Hostel Tower", "The League (Sports Arena)", 10),
    ("The League (Sports Arena)", "Swimming Pool & Blue Embers", 1), ("The League (Sports Arena)", "SportX", 10),
    ("Oval Dining Hall", "SportX", 10), ("SportX", "ICC Cricket Ground", 10),
    ("Swimming Pool & Blue Embers", "ICC Cricket Ground", 1),
    ("Trade Tower", "Student Hostel A", 40),            # southern ring back to the data centres
    ("SportX", "Student Hostel A", 10), ("Student Hostel A", "Student Hostel B", 10),
    ("Student Hostel B", "Student Hostel C", 10), ("Student Hostel C", "Student Hostel D", 10),
    ("Student Hostel D", "ICC Cricket Ground", 10),
]


def woxsen_campus() -> Graph:
    """Woxsen University, Kamkole (Sangareddy, Telangana).  Site names and their
    west-to-east arrangement follow the official campus map; the fibre plan,
    server sizes and the two data-centre locations are modelling assumptions.
    The campus spans roughly 1.7 km, so links are sub-millisecond."""
    g = Graph()
    for name, tier, x, y in WOXSEN_SITES:
        cpu, mem, cost = TIERS[tier]
        if tier == "core":
            cpu, mem, cost = 64, 256, 1.8
        if name.startswith("AI & Robotics"):
            cpu, mem, cost = 32, 256, 1.6  # GPU workstation room
        g.add_node(name=name, tier=tier, cpu=cpu, mem=mem, cost=cost, x=float(x), y=float(y))
    idx = {s[0]: i for i, s in enumerate(WOXSEN_SITES)}
    for a, b, bw in WOXSEN_FIBRE:
        u, v = idx[a], idx[b]
        meters = math.hypot(WOXSEN_SITES[u][2] - WOXSEN_SITES[v][2], WOXSEN_SITES[u][3] - WOXSEN_SITES[v][3]) * 1.8
        lat = round(0.05 + meters / 200_000.0 + (0.08 if bw <= 1 else 0.02 if bw <= 10 else 0.01), 4)
        g.add_edge(u, v, latency=lat, bandwidth=bw, meters=round(meters))
    return g


campus = woxsen_campus  # backwards-compatible name


def woxsen_services(g: Graph, rng: random.Random) -> list[Service]:
    """Campus workloads with demand where the users actually are."""
    idx = {a["name"]: i for i, a in enumerate(g.nodes)}
    H = ["Student Hostel A", "Student Hostel B", "Student Hostel C", "Student Hostel D", "Hostel Tower"]
    ACAD = ["Academic Block (Data Centre A)", "Trade Tower", "Central Library (Vithal Gandhi Centre)",
            "AI & Robotics Studio", "Bloomberg Finance Lab"]
    spec = [
        # name, cpu, mem, kmin, kmax, priority, {site: weight}
        ("learning-portal", 4, 16, 1, 4, 2.0, {**{h: 1.0 for h in H}, **{a: 0.8 for a in ACAD}}),
        ("wifi-auth", 2, 4, 2, 4, 2.0, {**{h: 1.0 for h in H}, "Oval Dining Hall": .6, "The League (Sports Arena)": .5,
                                        "Central Library (Vithal Gandhi Centre)": .8, "Admin Block / Gateway (Data Centre B)": .4}),
        ("library-search", 4, 16, 1, 3, 1.0, {"Central Library (Vithal Gandhi Centre)": 1.0, "Cup of Joe Café": .3,
                                              "Hostel Tower": .5, "Student Hostel B": .3, "Academic Block (Data Centre A)": .5}),
        ("bloomberg-feed", 4, 8, 1, 2, 1.5, {"Bloomberg Finance Lab": 1.0, "Trade Tower": .7}),
        ("ai-lab-gpu-jobs", 16, 64, 1, 2, 1.0, {"AI & Robotics Studio": 1.0, "Academic Block (Data Centre A)": .4,
                                                "Hostel Tower": .2}),
        ("lecture-capture", 8, 32, 1, 3, 1.0, {"Academic Block (Data Centre A)": 1.0, "Amphitheatre": .6, "Trade Tower": .5,
                                               **{h: .4 for h in H}}),
        ("dining-and-tuck-pos", 2, 4, 1, 3, 1.0, {"Oval Dining Hall": 1.0, "Ink & Water (Tuck Shop)": .6, "Rise Café": .5,
                                                  "Cup of Joe Café": .5, "Swimming Pool & Blue Embers": .4}),
        ("sports-live-stream", 8, 16, 1, 3, 1.0, {"The League (Sports Arena)": 1.0, "ICC Cricket Ground": .8, "SportX": .6,
                                                  **{h: .5 for h in H}}),
    ]
    out = []
    for j, (name, cpu, mem, kmin, kmax, pr, dem) in enumerate(spec):
        demand = {idx[k]: round(600 * w * rng.uniform(.8, 1.2), 1) for k, w in dem.items()}
        out.append(Service(id=j, name=name, cpu=cpu, mem=mem, demand=demand, min_replicas=kmin, max_replicas=kmax,
                           vm_cost=round(0.024 * cpu + 0.003 * mem, 3), priority=pr, color=PALETTE[j % len(PALETTE)]))
    return out


NIGERIA_CITIES = [  # 24 major Nigerian cities (real coordinates); links synthesised geographically
    ("Lagos", 6.52, 3.38), ("Abuja", 9.06, 7.49), ("Kano", 12.00, 8.52), ("Ibadan", 7.38, 3.95),
    ("Port Harcourt", 4.82, 7.03), ("Benin City", 6.34, 5.63), ("Kaduna", 10.52, 7.44), ("Enugu", 6.44, 7.50),
    ("Jos", 9.90, 8.86), ("Ilorin", 8.50, 4.55), ("Abeokuta", 7.16, 3.35), ("Onitsha", 6.15, 6.79),
    ("Warri", 5.52, 5.75), ("Calabar", 4.95, 8.32), ("Maiduguri", 11.83, 13.15), ("Sokoto", 13.06, 5.24),
    ("Owerri", 5.48, 7.03), ("Uyo", 5.04, 7.93), ("Akure", 7.25, 5.19), ("Yola", 9.20, 12.48),
    ("Makurdi", 7.73, 8.54), ("Bauchi", 10.31, 9.84), ("Minna", 9.61, 6.56), ("Katsina", 12.99, 7.60),
]
NIGERIA_CORE = ("Lagos", "Abuja", "Port Harcourt")


# ---------------------------------------------------------------- workloads
def make_services(g: Graph, J: int, rng: random.Random, clients_per_service: tuple[int, int] = (4, 10),
                  replica_range: tuple[int, int] = (1, 4)) -> list[Service]:
    n = g.n
    out = []
    for j in range(J):
        name, cpu, mem = SERVICE_CATALOG[j % len(SERVICE_CATALOG)]
        if j >= len(SERVICE_CATALOG):
            name = f"{name}-{j // len(SERVICE_CATALOG) + 1}"
        k_c = min(n, rng.randint(*clients_per_service))
        # clustered demand: pick a centre, prefer nearby clients (locality)
        centre = rng.randrange(n)
        cx, cy = g.nodes[centre]["x"], g.nodes[centre]["y"]
        weights = [math.exp(-math.hypot(g.nodes[v]["x"] - cx, g.nodes[v]["y"] - cy) / 350.0) + 0.05 for v in range(n)]
        chosen: set[int] = set()
        while len(chosen) < k_c:
            chosen.add(rng.choices(range(n), weights=weights)[0])
        demand = {}
        for rank, c in enumerate(sorted(chosen, key=lambda _: rng.random())):
            demand[c] = round(1000.0 / (rank + 1) ** 0.9 * rng.uniform(0.7, 1.3), 1)  # Zipf-ish
        kmin = rng.choice([1, 1, 2]) if replica_range[0] <= 1 else replica_range[0]
        kmax = max(kmin, rng.randint(max(kmin, replica_range[0]), replica_range[1]) + 1)
        out.append(Service(id=j, name=name, cpu=cpu, mem=mem, demand=demand, min_replicas=kmin,
                           max_replicas=kmax, vm_cost=round(0.024 * cpu + 0.003 * mem, 3),
                           priority=rng.choice([1.0, 1.0, 1.5, 2.0]), color=PALETTE[j % len(PALETTE)]))
    return out


def make_tasks(g: Graph, T: int, rng: random.Random) -> list[BatchTask]:
    kinds = ["etl", "train", "render", "backup", "index", "report", "encode", "simulate"]
    return [BatchTask(id=t, name=f"{rng.choice(kinds)}-{t:02d}", duration=round(rng.lognormvariate(3.6, 0.7), 1),
                      data_node=rng.randrange(g.n), data_gb=round(rng.uniform(0.5, 20), 1),
                      priority=rng.choice([1.0, 2.0, 3.0])) for t in range(T)]


def build_instance(model: str = "waxman", n: int = 30, seed: int = 0, services: int = 6, tasks: int = 12,
                   capacity_factor: float = 1.0, budget_factor: float = 1.6, **params: Any) -> Instance:
    """Generate a complete instance. ``model`` in waxman | erdos_renyi | barabasi_albert |
    fat_tree | abilene | nsfnet | india | nigeria | woxsen (alias campus)."""
    rng = random.Random(seed * 7919 + 17)
    source, desc = "synthetic", ""
    if model == "waxman":
        g = waxman(n, params.get("alpha", 0.4), params.get("beta", 0.12), seed)
        desc = f"Waxman geographic WAN, n={n}"
    elif model == "erdos_renyi":
        p = params.get("p", min(1.0, 4.0 / max(n - 1, 1)))
        g = erdos_renyi(n, p, seed)
        desc = f"Erdős–Rényi G(n={n}, p={p:.3f}) with spanning tree"
    elif model == "barabasi_albert":
        g = barabasi_albert(n, params.get("m", 2), seed)
        desc = f"Barabási–Albert scale-free, n={n}, m={params.get('m', 2)}"
    elif model == "fat_tree":
        g = fat_tree(params.get("k", 4), seed)
        desc = f"k={params.get('k', 4)} fat-tree data centre"
    elif model == "abilene":
        g = from_cities(ABILENE["nodes"], ABILENE["links"], seed=seed)
        source, desc = "real", "Internet2 Abilene backbone (11 PoPs, 14 links)"
    elif model == "nsfnet":
        g = from_cities(NSFNET["nodes"], NSFNET["links"], seed=seed)
        source, desc = "real", "NSFNET T1 backbone (14 nodes, 21 links)"
    elif model == "india":
        g = from_cities(INDIA_CITIES, None, params.get("k_nearest", 3), seed)
        source, desc = "real-coordinates", "24 Indian metros plus Woxsen University, geographic 3-nearest-neighbour mesh"
    elif model == "nigeria":
        g = from_cities(NIGERIA_CITIES, None, params.get("k_nearest", 3), seed)
        source, desc = "real-coordinates", "24 Nigerian cities, geographic 3-nearest-neighbour mesh"
    elif model in ("woxsen", "campus"):
        g = woxsen_campus()
        source, desc = "campus-map", "Woxsen University campus, Kamkole (23 sites from the campus map)"
    else:
        raise ValueError(f"unknown model {model}")
    if model not in ("fat_tree", "campus", "woxsen"):
        assign_tiers(g, rng, capacity_factor, router_frac=params.get("router_frac", 0.15))
        if model == "nigeria":  # the three commercial hubs host the core data centres
            for a in g.nodes:
                t = "core" if a["name"] in NIGERIA_CORE else ("regional" if a["tier"] == "core" else a["tier"])
                cpu, mem, cost = TIERS[t]
                a.update(tier=t, cpu=round(cpu * capacity_factor), mem=round(mem * capacity_factor), cost=cost)
    elif capacity_factor != 1.0:
        for a in g.nodes:
            a["cpu"] = round(a.get("cpu", 0) * capacity_factor)
            a["mem"] = round(a.get("mem", 0) * capacity_factor)
    # negative transfer costs come from site price levels (model/costs.py), so no per-link rebates are stored
    svcs = woxsen_services(g, rng) if model in ("woxsen", "campus") else make_services(g, services, rng)
    tsk = make_tasks(g, tasks, rng)
    budget = round(budget_factor * sum(s.vm_cost * s.min_replicas for s in svcs), 2)
    named = ("abilene", "nsfnet", "india", "nigeria", "woxsen", "campus")
    name = params.get("name") or ("woxsen" if model == "campus" else model if model in named else f"{model}-{n}-s{seed}")
    region = "nigeria" if model == "nigeria" else "india" if model in ("india", "woxsen", "campus") else "global"
    return Instance(name=name, graph=g, services=svcs, tasks=tsk, budget=budget, description=desc, source=source,
                    meta={"model": model, "n": g.n, "seed": seed, "capacity_factor": capacity_factor, "region": region, **params})
