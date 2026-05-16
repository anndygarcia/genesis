"""FastAPI-side runner that turns a FloorPlan into a real 3D shell GLB.

The actual geometry build runs in Blender's Python interpreter (see
``blender_build.py``). This module's job is to:

  1. Locate the Blender binary (``GENESIS_BLENDER_BIN`` env var or
     ``blender`` on PATH).
  2. Stage the FloorPlan JSON to a per-job artifact directory.
  3. Spawn ``blender --background --python blender_build.py`` and
     wait for completion.
  4. Return the artifact paths so the API layer can mount or stream them.

Artifacts are written under ``pipeline/_artifacts/<job_id>/`` with a
plain filesystem layout so a future Cycles still-render or Unreal
exporter can drop files alongside the GLB without coordination.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from ..schemas import FloorPlan


logger = logging.getLogger("genesis.pipeline.plan_to_3d")


PIPELINE_DIR = Path(__file__).resolve().parent.parent
ARTIFACTS_DIR = PIPELINE_DIR / "_artifacts"
BLENDER_SCRIPT = PIPELINE_DIR / "geometry" / "blender_build.py"


@dataclass(frozen=True)
class ShellBuildResult:
    job_id: str
    glb_path: Path
    plan_path: Path
    log_path: Path
    duration_s: float
    blender_bin: str

    @property
    def glb_relpath(self) -> str:
        """Path relative to ARTIFACTS_DIR for static-mounting purposes."""
        return str(self.glb_path.relative_to(ARTIFACTS_DIR)).replace(os.sep, "/")


class BlenderUnavailable(RuntimeError):
    """Raised when the Blender binary cannot be located."""


def find_blender() -> str:
    """Return the path to the Blender binary, raising if not found.

    Resolution order:
      1. ``GENESIS_BLENDER_BIN`` env var (explicit override).
      2. ``blender`` on PATH.
      3. macOS app bundle default: ``/Applications/Blender.app/Contents/MacOS/Blender``.
    """
    explicit = os.environ.get("GENESIS_BLENDER_BIN")
    if explicit:
        if os.path.isfile(explicit) and os.access(explicit, os.X_OK):
            return explicit
        raise BlenderUnavailable(f"GENESIS_BLENDER_BIN points to non-executable path: {explicit}")

    found = shutil.which("blender")
    if found:
        return found

    mac_default = "/Applications/Blender.app/Contents/MacOS/Blender"
    if os.path.isfile(mac_default) and os.access(mac_default, os.X_OK):
        return mac_default

    raise BlenderUnavailable(
        "Blender not found. Install Blender 3.6+ and either put it on PATH or set "
        "GENESIS_BLENDER_BIN to the binary path."
    )


def _new_job_dir() -> tuple[str, Path]:
    job_id = uuid.uuid4().hex[:12]
    out = ARTIFACTS_DIR / job_id
    out.mkdir(parents=True, exist_ok=True)
    return job_id, out


def build_shell(plan: FloorPlan, *, ridge_height: float = 2.0,
                eave_overhang: float = 0.4,
                blender_timeout_s: float = 90.0) -> ShellBuildResult:
    """Build a 3D shell GLB for ``plan`` and return artifact paths.

    Raises ``BlenderUnavailable`` if Blender isn't installed, or
    ``RuntimeError`` if the Blender subprocess fails. The caller is
    responsible for surfacing these as HTTP 503 / 500 respectively.
    """
    blender = find_blender()
    job_id, job_dir = _new_job_dir()

    plan_path = job_dir / "plan.json"
    glb_path = job_dir / "shell.glb"
    log_path = job_dir / "build.log"

    plan_path.write_text(plan.model_dump_json(indent=2), encoding="utf-8")

    cmd = [
        blender,
        "--background",
        "--factory-startup",
        "--python", str(BLENDER_SCRIPT),
        "--",
        "--plan", str(plan_path),
        "--out", str(glb_path),
        "--ridge-height", str(ridge_height),
        "--eave-overhang", str(eave_overhang),
    ]

    logger.info("build_shell: job=%s blender=%s", job_id, blender)
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
        raise RuntimeError(f"Blender build timed out after {blender_timeout_s}s (job {job_id})") from exc

    duration = time.monotonic() - started
    log_path.write_text(
        f"command: {' '.join(cmd)}\nrc: {proc.returncode}\nduration_s: {duration:.2f}\n\n"
        f"stdout:\n{proc.stdout}\n\nstderr:\n{proc.stderr}\n",
        encoding="utf-8",
    )

    if proc.returncode != 0 or not glb_path.exists():
        snippet_err = (proc.stderr or "").strip().splitlines()[-5:]
        snippet_out = (proc.stdout or "").strip().splitlines()[-3:]
        tail = " | ".join(snippet_err + snippet_out)
        raise RuntimeError(
            f"Blender build failed (rc={proc.returncode}, job={job_id}). Last log lines: {tail}"
        )

    logger.info(
        "build_shell: job=%s ok in %.2fs glb=%s (%d bytes)",
        job_id, duration, glb_path, glb_path.stat().st_size,
    )
    return ShellBuildResult(
        job_id=job_id,
        glb_path=glb_path,
        plan_path=plan_path,
        log_path=log_path,
        duration_s=duration,
        blender_bin=blender,
    )


def is_available() -> bool:
    """Cheap check used by /health to advertise capability."""
    try:
        find_blender()
        return True
    except BlenderUnavailable:
        return False
