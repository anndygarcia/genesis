"""FastAPI-side runner for Cycles hero renders.

Mirrors ``plan_to_3d.py`` but spawns ``blender_render.py`` to produce
PNGs of the home from configurable camera angles. Artifacts land under
the same per-job directory layout::

    pipeline/_artifacts/<job_id>/
        plan.json
        render_exterior_front.png
        render_exterior_aerial.png
        render_interior_living.png
        render_interior_master.png
        render.log
"""

from __future__ import annotations

import logging
import os
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence

from ..schemas import FloorPlan
from .plan_to_3d import (
    ARTIFACTS_DIR,
    BlenderUnavailable,
    PIPELINE_DIR,
    find_blender,
)


logger = logging.getLogger("genesis.pipeline.render_views")


RENDER_SCRIPT = PIPELINE_DIR / "geometry" / "blender_render.py"


VALID_VIEWS = (
    "exterior_front",
    "exterior_aerial",
    "interior_living",
    "interior_master",
)


@dataclass(frozen=True)
class RenderedView:
    view: str
    path: Path

    @property
    def relpath(self) -> str:
        return str(self.path.relative_to(ARTIFACTS_DIR)).replace(os.sep, "/")


@dataclass(frozen=True)
class RenderResult:
    job_id: str
    job_dir: Path
    renders: List[RenderedView]
    duration_s: float
    blender_bin: str
    samples: int
    resolution: tuple[int, int]


def render_views(
    plan: FloorPlan,
    *,
    views: Optional[Sequence[str]] = None,
    samples: int = 32,
    resolution: tuple[int, int] = (1280, 720),
    use_gpu: bool = False,
    ridge_height: float = 2.0,
    eave_overhang: float = 0.4,
    blender_timeout_s: float = 600.0,
    job_id: Optional[str] = None,
) -> RenderResult:
    """Render the requested camera angles via Blender Cycles.

    Pass ``job_id`` to write into an existing job directory (lets the
    same UUID hold both a `shell.glb` and `render_*.png` artifacts).
    Otherwise a new job dir is created.
    """

    blender = find_blender()

    selected = list(views) if views else list(VALID_VIEWS)
    bad = [v for v in selected if v not in VALID_VIEWS]
    if bad:
        raise ValueError(f"Unknown views: {bad}; valid: {VALID_VIEWS}")
    if not selected:
        raise ValueError("At least one view is required.")

    if job_id is None:
        job_id = uuid.uuid4().hex[:12]
    job_dir = ARTIFACTS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    plan_path = job_dir / "plan.json"
    log_path = job_dir / "render.log"
    plan_path.write_text(plan.model_dump_json(indent=2), encoding="utf-8")

    cmd = [
        blender,
        "--background",
        "--factory-startup",
        "--python", str(RENDER_SCRIPT),
        "--",
        "--plan", str(plan_path),
        "--out-dir", str(job_dir),
        "--views", ",".join(selected),
        "--samples", str(int(samples)),
        "--resolution", str(int(resolution[0])), str(int(resolution[1])),
        "--ridge-height", str(ridge_height),
        "--eave-overhang", str(eave_overhang),
    ]
    if use_gpu:
        cmd.append("--use-gpu")

    logger.info(
        "render_views: job=%s blender=%s views=%s samples=%d res=%dx%d gpu=%s",
        job_id, blender, selected, samples, resolution[0], resolution[1], use_gpu,
    )

    started = time.monotonic()
    try:
        proc = subprocess.run(
            cmd,
            cwd=PIPELINE_DIR,
            capture_output=True,
            text=True,
            timeout=blender_timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        log_path.write_text(
            f"TIMEOUT after {blender_timeout_s}s\nstdout:\n{exc.stdout or ''}\nstderr:\n{exc.stderr or ''}",
            encoding="utf-8",
        )
        raise RuntimeError(f"Blender render timed out after {blender_timeout_s}s (job {job_id})") from exc

    duration = time.monotonic() - started
    log_path.write_text(
        f"command: {' '.join(cmd)}\nrc: {proc.returncode}\nduration_s: {duration:.2f}\n\n"
        f"stdout:\n{proc.stdout}\n\nstderr:\n{proc.stderr}\n",
        encoding="utf-8",
    )

    if proc.returncode != 0:
        snippet_err = (proc.stderr or "").strip().splitlines()[-5:]
        snippet_out = (proc.stdout or "").strip().splitlines()[-3:]
        tail = " | ".join(snippet_err + snippet_out)
        raise RuntimeError(
            f"Blender render failed (rc={proc.returncode}, job={job_id}). Last log lines: {tail}"
        )

    rendered: List[RenderedView] = []
    for view in selected:
        path = job_dir / f"render_{view}.png"
        if path.exists():
            rendered.append(RenderedView(view=view, path=path))
        else:
            logger.warning("render_views: expected %s missing", path)

    if not rendered:
        raise RuntimeError(f"Blender render produced no PNGs (job {job_id}). See {log_path}")

    logger.info(
        "render_views: job=%s ok in %.2fs (%d/%d views)",
        job_id, duration, len(rendered), len(selected),
    )
    return RenderResult(
        job_id=job_id,
        job_dir=job_dir,
        renders=rendered,
        duration_s=duration,
        blender_bin=blender,
        samples=int(samples),
        resolution=(int(resolution[0]), int(resolution[1])),
    )


def is_available() -> bool:
    try:
        find_blender()
        return True
    except BlenderUnavailable:
        return False
