"""End-to-end smoke test for the Genesis pipeline.

Boots the FastAPI app, hits each endpoint with a representative payload,
validates the response shape against the wire schema the React frontend
expects, and tears the server back down.

Usage::

    # From repo root with deps installed:
    python -m pipeline.scripts.smoke_test                # /health + /generate_house
    python -m pipeline.scripts.smoke_test --shell        # also exercise /build_shell (needs Blender)
    python -m pipeline.scripts.smoke_test --shell --renders   # also exercise /render_views

    # Against an already-running server (skip auto-boot):
    python -m pipeline.scripts.smoke_test --base http://127.0.0.1:8787

The script is stdlib-only beyond what the pipeline already requires, so
``pip install -r pipeline/requirements.txt`` is enough to run it.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import closing
from pathlib import Path
from typing import Any, Optional, Tuple


REPO_ROOT = Path(__file__).resolve().parents[2]


# ---------------------------------------------------------------------------
# Tiny HTTP helpers (stdlib only, so we don't add a smoke-test dep)
# ---------------------------------------------------------------------------

def _request(method: str, url: str, body: Optional[dict] = None, timeout: float = 60.0) -> Tuple[int, dict | str]:
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw


def _free_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_health(base: str, timeout_s: float = 20.0) -> dict:
    deadline = time.time() + timeout_s
    last_err: Optional[str] = None
    while time.time() < deadline:
        try:
            status, payload = _request("GET", f"{base}/health", timeout=2.0)
            if status == 200 and isinstance(payload, dict) and payload.get("ok") is True:
                return payload
            last_err = f"status={status} payload={payload!r}"
        except (urllib.error.URLError, ConnectionRefusedError, TimeoutError) as exc:
            last_err = repr(exc)
        time.sleep(0.4)
    raise RuntimeError(f"server did not become healthy in {timeout_s}s (last: {last_err})")


# ---------------------------------------------------------------------------
# Validation helpers (mirror src/lib/floorplan.ts)
# ---------------------------------------------------------------------------

ROOM_KINDS = {
    "living_room", "bedroom", "master_bedroom", "kitchen", "dining_room",
    "bathroom", "office", "garage", "hallway", "laundry", "closet", "entry",
}
OPENING_KINDS = {"door", "window", "garage_door"}


class SchemaError(AssertionError):
    pass


def _expect(cond: bool, msg: str) -> None:
    if not cond:
        raise SchemaError(msg)


def validate_floorplan(plan: Any) -> None:
    _expect(isinstance(plan, dict), "plan must be a dict")
    _expect(plan.get("version") == 1, f"plan.version must be 1, got {plan.get('version')!r}")

    meta = plan.get("meta")
    _expect(isinstance(meta, dict), "plan.meta must be a dict")
    for key in ("style", "sqft", "floors", "generatedAt", "seed"):
        _expect(key in meta, f"plan.meta missing {key}")

    rooms = plan.get("rooms")
    _expect(isinstance(rooms, list) and rooms, "plan.rooms must be a non-empty list")
    for room in rooms:
        for key in ("id", "kind", "name", "min", "max", "level", "ceilingHeight"):
            _expect(key in room, f"room missing {key}: {room!r}")
        _expect(room["kind"] in ROOM_KINDS, f"unknown room.kind {room['kind']!r}")
        for corner in ("min", "max"):
            v = room[corner]
            _expect(isinstance(v, dict) and "x" in v and "z" in v, f"room.{corner} must be Vec2")

    walls = plan.get("walls")
    _expect(isinstance(walls, list) and walls, "plan.walls must be a non-empty list")
    wall_ids = {w["id"] for w in walls}
    for wall in walls:
        for key in ("id", "a", "b", "level", "height", "thickness", "exterior"):
            _expect(key in wall, f"wall missing {key}: {wall!r}")

    openings = plan.get("openings")
    _expect(isinstance(openings, list), "plan.openings must be a list")
    for op in openings:
        for key in ("id", "wallId", "kind", "offset", "width", "height", "sill"):
            _expect(key in op, f"opening missing {key}: {op!r}")
        _expect(op["kind"] in OPENING_KINDS, f"unknown opening.kind {op['kind']!r}")
        _expect(op["wallId"] in wall_ids, f"opening references missing wall {op['wallId']!r}")

    furniture = plan.get("furniture")
    _expect(isinstance(furniture, list), "plan.furniture must be a list")
    room_ids = {r["id"] for r in rooms}
    for f in furniture:
        for key in ("id", "kind", "name", "roomId", "position", "rotation", "scale"):
            _expect(key in f, f"furniture item missing {key}: {f!r}")
        _expect(f["roomId"] in room_ids, f"furniture references missing room {f['roomId']!r}")
        for vec_key in ("position", "rotation", "scale"):
            v = f[vec_key]
            _expect(isinstance(v, list) and len(v) == 3, f"furniture.{vec_key} must be 3-tuple")


def validate_brief(brief: Any) -> None:
    _expect(isinstance(brief, dict), "brief must be a dict")
    for key in ("program", "rationale", "warnings", "codeIssues"):
        _expect(key in brief, f"brief missing {key}")
    _expect(isinstance(brief["warnings"], list), "brief.warnings must be a list")
    _expect(isinstance(brief["codeIssues"], list), "brief.codeIssues must be a list")
    for issue in brief["codeIssues"]:
        for key in ("severity", "code", "message"):
            _expect(key in issue, f"codeIssue missing {key}: {issue!r}")
        _expect(issue["severity"] in {"info", "warning", "error"}, f"bad severity {issue['severity']!r}")


# ---------------------------------------------------------------------------
# Test bodies
# ---------------------------------------------------------------------------

SAMPLE_INTAKE: dict = {
    "basics": {"floors": 1, "sqft": 1800.0},
    "rooms": {"beds": 3, "baths": 2, "garage": 2},
    "style": {"archetype": "modern-farmhouse", "refs": []},
    "budget": {"amount": 450000.0},
    "notes": "Open kitchen, big windows in living, master at the back.",
    "seed": 42,
}


def test_health(base: str) -> dict:
    print("→ GET /health")
    status, payload = _request("GET", f"{base}/health")
    _expect(status == 200, f"/health returned {status}")
    _expect(isinstance(payload, dict) and payload.get("ok") is True, f"/health bad payload: {payload!r}")
    print(f"  ✔ ok=True service={payload.get('service')!r} version={payload.get('version')!r} "
          f"capabilities={payload.get('capabilities')!r}")
    return payload


def test_generate(base: str) -> dict:
    print("→ POST /generate_house")
    t0 = time.time()
    status, payload = _request("POST", f"{base}/generate_house", body=SAMPLE_INTAKE, timeout=120)
    dt = time.time() - t0
    _expect(status == 200, f"/generate_house returned {status}: {payload!r}")
    _expect(isinstance(payload, dict), "/generate_house payload must be a dict")
    plan = payload.get("plan")
    brief = payload.get("brief")
    validate_floorplan(plan)
    validate_brief(brief)
    print(f"  ✔ {dt:.2f}s  rooms={len(plan['rooms'])} walls={len(plan['walls'])} "
          f"openings={len(plan['openings'])} furniture={len(plan['furniture'])}")
    print(f"     style={plan['meta']['style']!r}  source={plan['meta'].get('source')!r}")
    n_err = sum(1 for i in brief["codeIssues"] if i["severity"] == "error")
    n_warn = sum(1 for i in brief["codeIssues"] if i["severity"] == "warning")
    n_info = sum(1 for i in brief["codeIssues"] if i["severity"] == "info")
    print(f"     brief.codeIssues: {n_err} errors / {n_warn} warnings / {n_info} info")
    if brief["warnings"]:
        print(f"     brief.warnings: {brief['warnings']}")
    return payload


def test_shell(base: str, plan: dict) -> dict:
    print("→ POST /build_shell")
    t0 = time.time()
    status, payload = _request("POST", f"{base}/build_shell", body={"plan": plan}, timeout=180)
    dt = time.time() - t0
    if status != 200:
        print(f"  ✖ /build_shell returned {status}: {payload!r}")
        print("    (Skipping if Blender is unavailable. Set BLENDER_BIN or install Blender.app.)")
        return {}
    for key in ("job_id", "glb_url", "duration_s", "blender_bin"):
        _expect(key in payload, f"/build_shell missing {key}: {payload!r}")
    print(f"  ✔ {dt:.2f}s  job_id={payload['job_id']}  glb={payload['glb_url']}  "
          f"blender={payload['blender_bin']}")
    return payload


def test_renders(base: str, plan: dict, job_id: Optional[str]) -> dict:
    print("→ POST /render_views (samples=8 for speed)")
    body: dict = {"plan": plan, "samples": 8, "resolution": [640, 360]}
    if job_id:
        body["job_id"] = job_id
    t0 = time.time()
    status, payload = _request("POST", f"{base}/render_views", body=body, timeout=600)
    dt = time.time() - t0
    if status != 200:
        print(f"  ✖ /render_views returned {status}: {payload!r}")
        return {}
    _expect(isinstance(payload.get("renders"), list) and payload["renders"], "no renders returned")
    print(f"  ✔ {dt:.2f}s  job_id={payload['job_id']}  views={[r['view'] for r in payload['renders']]}")
    return payload


def test_critique(base: str, job_id: Optional[str]) -> dict:
    print("→ POST /critique_renders")
    if not job_id:
        print("  ⊘ skipping critique — no job_id from render step")
        return {}
    t0 = time.time()
    status, payload = _request("POST", f"{base}/critique_renders", body={"job_id": job_id}, timeout=120)
    dt = time.time() - t0
    if status != 200:
        print(f"  ⚠ /critique_renders returned {status}: {payload!r}")
        print("    (VLM may be unconfigured; this is not a fatal smoke-test failure.)")
        return {}
    _expect(isinstance(payload.get("critiques"), list), "critiques must be a list")
    avg = payload.get("average_score")
    print(f"  ✔ {dt:.2f}s  job_id={payload['job_id']}  views={len(payload['critiques'])}  avg_score={avg}")
    return payload


def test_refine(base: str, gen: dict) -> dict:
    print("→ POST /refine_plan (synthetic low-score critique)")
    plan = gen["plan"]
    brief = gen["brief"]
    intake = gen.get("request") or SAMPLE_INTAKE
    # Build a synthetic critique that forces refinement (score below threshold).
    critique: dict = {
        "job_id": "smoke-test-job",
        "critiques": [
            {
                "view": "front_hero",
                "strengths": ["Good proportions"],
                "issues": ["Windows feel small", "Entry lacks porch depth"],
                "suggestions": ["Increase window height", "Add a covered porch"],
                "score": 5.5,
                "summary": "Promising but needs refinement.",
            }
        ],
        "average_score": 5.5,
        "overall_summary": "Promising but needs refinement.",
        "duration_s": 0.1,
        "warnings": [],
    }
    body: dict = {
        "intake": intake,
        "previous_brief": brief,
        "critique": critique,
        "iteration": 2,
        "min_score": 7.5,
        "force": False,
    }
    t0 = time.time()
    status, payload = _request("POST", f"{base}/refine_plan", body=body, timeout=120)
    dt = time.time() - t0
    if status != 200:
        print(f"  ⚠ /refine_plan returned {status}: {payload!r}")
        print("    (LLM may be unconfigured; this is not a fatal smoke-test failure.)")
        return {}
    _expect("refined" in payload, "refined field missing")
    refined = payload["refined"]
    skip = payload.get("skip_reason")
    print(f"  ✔ {dt:.2f}s  refined={refined}  iteration={payload.get('iteration')}  skip={skip}")
    if refined and payload.get("plan"):
        validate_floorplan(payload["plan"])
        validate_brief(payload["brief"])
    return payload


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def boot_server(port: int) -> subprocess.Popen:
    env = os.environ.copy()
    env.setdefault("GENESIS_LOG_LEVEL", "WARNING")
    cmd = [sys.executable, "-m", "uvicorn", "pipeline.api.server:app",
           "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"]
    print(f"→ booting uvicorn on :{port}  ({' '.join(cmd)})")
    return subprocess.Popen(cmd, cwd=str(REPO_ROOT), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)


def main() -> int:
    parser = argparse.ArgumentParser(description="Genesis pipeline smoke test")
    parser.add_argument("--base", help="Hit an already-running server at this base URL "
                                       "(e.g. http://127.0.0.1:8787) instead of booting one.")
    parser.add_argument("--shell", action="store_true", help="Also exercise /build_shell (needs Blender).")
    parser.add_argument("--renders", action="store_true", help="Also exercise /render_views (needs Blender; implies --shell).")
    args = parser.parse_args()

    if args.renders:
        args.shell = True

    proc: Optional[subprocess.Popen] = None
    base = args.base.rstrip("/") if args.base else None
    try:
        if base is None:
            port = _free_port()
            base = f"http://127.0.0.1:{port}"
            proc = boot_server(port)
            _wait_for_health(base)
        else:
            print(f"→ using existing server at {base}")
            _wait_for_health(base, timeout_s=5.0)

        test_health(base)
        gen = test_generate(base)

        if args.shell:
            shell = test_shell(base, gen["plan"])
            renders = {}
            if args.renders and shell:
                renders = test_renders(base, gen["plan"], shell.get("job_id"))
            # Critique depends on renders existing on disk.
            if args.renders and renders:
                test_critique(base, renders.get("job_id"))

        # Refine uses a synthetic critique so it works even without VLM.
        test_refine(base, gen)

        print("\n✅ smoke test passed")
        return 0
    except SchemaError as exc:
        print(f"\n❌ schema mismatch: {exc}")
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"\n❌ smoke test failed: {exc!r}")
        return 1
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
