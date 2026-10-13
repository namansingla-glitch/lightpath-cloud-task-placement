import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from api.server import app  # noqa: E402

client = TestClient(app)


def test_health_and_datasets():
    assert client.get("/api/health").json()["ok"]
    ds = client.get("/api/datasets").json()
    assert {d["name"] for d in ds} >= {"abilene", "india", "nigeria", "woxsen"}
    one = client.get("/api/datasets/abilene").json()
    assert one["summary"]["nodes"] == 11
    assert client.get("/api/datasets/nope").status_code == 404
    assert client.get("/api/datasets/..%2Fsecret").status_code == 404


def test_generate_and_solve_roundtrip():
    inst = client.post("/api/generate", json={"model": "waxman", "n": 25, "seed": 3}).json()
    assert inst["summary"]["nodes"] == 25
    out = client.post("/api/solve", json={"instance": inst, "config": {"server_budget": None}}).json()
    assert out["best"] and out["policy"]["routes"]
    assert client.post("/api/generate", json={"model": "bogus"}).status_code == 422
    assert client.post("/api/generate", json={"n": 100000}).status_code == 422
    assert client.post("/api/solve", json={}).status_code == 422


@pytest.mark.parametrize("alg", ["prim", "kruskal", "dijkstra", "bellman_ford", "floyd_warshall", "johnson"])
def test_algorithms(alg):
    r = client.post("/api/algorithms/run", json={"dataset": "nsfnet", "algorithm": alg, "source": 2})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["runtime_ms"] >= 0
    if alg in ("prim", "kruskal", "dijkstra", "bellman_ford"):
        assert body["trace"]


def test_bad_algorithm_and_source():
    assert client.post("/api/algorithms/run", json={"dataset": "nsfnet", "algorithm": "x"}).status_code == 422
    assert client.post("/api/algorithms/run", json={"dataset": "nsfnet", "source": 99}).status_code == 422


def test_static_server_cannot_escape_dist():
    for bad in ["/..%2F..%2Fapi%2Fserver.py", "/%2e%2e/%2e%2e/api/server.py", "/demo/../../api/server.py"]:
        r = client.get(bad)
        assert "fastapi" not in r.text.lower() and "def solve_ep" not in r.text
    assert client.get("/api/does-not-exist").status_code == 404
