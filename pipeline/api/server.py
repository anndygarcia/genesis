"""FastAPI server for the Genesis pipeline.

Endpoints
---------

GET  /health           - Liveness probe.
POST /generate_house   - Run architect agent + floorplan solver and return a
                         FloorPlan + brief.

The server is intentionally thin: each agent / solver is a plain Python
module under ``pipeline/`` so they can be unit-tested in isolation and
later replaced with real model calls (LLM brief, HouseDiffusion, Blender
extrusion, etc.). Wire-format types live in ``pipeline.schemas`` and
mirror ``src/lib/floorplan.ts`` exactly.

Run locally::

    pip install -r pipeline/requirements.txt
    uvicorn pipeline.api.server:app --reload --port 8787
"""

from __future__ import annotations

import logging
import os
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ..agents.architect import build_program, build_program_refine, write_brief
from ..agents.asset_retrieval import enrich_with_assets
from ..agents.code_check import review_plan
from ..agents.render_critique import (
    KNOWN_VIEWS as KNOWN_CRITIQUE_VIEWS,
    critique_renders_by_job,
)
from ..agents.style_refs import analyze_style_refs
from ..geometry.floorplan import solve_floorplan
from ..geometry.plan_to_3d import (
    ARTIFACTS_DIR,
    BlenderUnavailable,
    build_shell,
    is_available as blender_available,
)
from ..geometry.render_views import (
    VALID_VIEWS,
    render_views as render_views_runner,
)
from ..schemas import (
    ArchitectBrief,
    FloorPlan,
    GenerateHouseRequest,
    GenerateHouseResponse,
    IterationMeta,
    RendersCritique,
)
from ..vlm import get_vlm_client


SERVICE_NAME = "genesis-pipeline"
SERVICE_VERSION = "0.1.0"

logger = logging.getLogger("genesis.pipeline")
logging.basicConfig(level=os.environ.get("GENESIS_LOG_LEVEL", "INFO"))


def _allowed_origins() -> List[str]:
    raw = os.environ.get("GENESIS_ALLOWED_ORIGINS", "")
    if raw.strip():
        return [o.strip() for o in raw.split(",") if o.strip()]
    # Sensible defaults for local Vite dev servers.
    return [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ]


app = FastAPI(title="Genesis Pipeline", version=SERVICE_VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

# Serve build artifacts (GLBs, render PNGs, logs) under /artifacts/<job_id>/...
ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/artifacts", StaticFiles(directory=str(ARTIFACTS_DIR)), name="artifacts")


@app.get("/health")
def health() -> dict:
    vlm = get_vlm_client()
    return {
        "ok": True,
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "capabilities": {
            "blender_shell": blender_available(),
            "vlm": vlm is not None,
            "vlm_backend": type(vlm).__name__ if vlm else None,
        },
    }


# ---------------------------------------------------------------------------
# Shell build endpoint
# ---------------------------------------------------------------------------


class BuildShellRequest(BaseModel):
    plan: FloorPlan
    ridge_height: float = 2.0
    eave_overhang: float = 0.4


class BuildShellResponse(BaseModel):
    job_id: str
    glb_url: str
    duration_s: float
    blender_bin: str


@app.post("/build_shell", response_model=BuildShellResponse)
def build_shell_endpoint(req: BuildShellRequest, request_obj=None) -> BuildShellResponse:
    try:
        result = build_shell(
            req.plan,
            ridge_height=req.ridge_height,
            eave_overhang=req.eave_overhang,
        )
    except BlenderUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except RuntimeError as exc:
        logger.exception("build_shell failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return BuildShellResponse(
        job_id=result.job_id,
        glb_url=f"/artifacts/{result.glb_relpath}",
        duration_s=result.duration_s,
        blender_bin=result.blender_bin,
    )


# ---------------------------------------------------------------------------
# Cycles hero render endpoint
# ---------------------------------------------------------------------------


class RenderViewsRequest(BaseModel):
    plan: FloorPlan
    views: List[str] = list(VALID_VIEWS)
    samples: int = 32
    resolution: tuple[int, int] = (1280, 720)
    use_gpu: bool = False
    ridge_height: float = 2.0
    eave_overhang: float = 0.4
    job_id: Optional[str] = None


class RenderedViewPayload(BaseModel):
    view: str
    url: str


class RenderViewsResponse(BaseModel):
    job_id: str
    renders: List[RenderedViewPayload]
    duration_s: float
    blender_bin: str
    samples: int
    resolution: tuple[int, int]


@app.post("/render_views", response_model=RenderViewsResponse)
def render_views_endpoint(req: RenderViewsRequest) -> RenderViewsResponse:
    try:
        result = render_views_runner(
            req.plan,
            views=req.views,
            samples=req.samples,
            resolution=req.resolution,
            use_gpu=req.use_gpu,
            ridge_height=req.ridge_height,
            eave_overhang=req.eave_overhang,
            job_id=req.job_id,
        )
    except BlenderUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        logger.exception("render_views failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return RenderViewsResponse(
        job_id=result.job_id,
        renders=[
            RenderedViewPayload(view=r.view, url=f"/artifacts/{r.relpath}")
            for r in result.renders
        ],
        duration_s=result.duration_s,
        blender_bin=result.blender_bin,
        samples=result.samples,
        resolution=result.resolution,
    )


# ---------------------------------------------------------------------------
# VLM render critique endpoint
# ---------------------------------------------------------------------------


class CritiqueRendersRequest(BaseModel):
    """Critique an existing set of Cycles renders by job_id.

    The renders must already exist on disk under
    ``pipeline/_artifacts/<job_id>/render_<view>.png`` (i.e. produced by
    a successful ``/render_views`` call). Pass ``views`` to filter to a
    subset; default is "all renders the agent finds in the job dir".
    """

    job_id: str
    views: Optional[List[str]] = None
    max_tokens: int = 500


@app.post("/critique_renders", response_model=RendersCritique)
def critique_renders_endpoint(req: CritiqueRendersRequest) -> RendersCritique:
    # Sanitize the job_id eagerly: it goes into a Path join so a path
    # traversal attempt would let a caller read arbitrary files. The
    # agent does a defense-in-depth check too, but rejecting up front
    # produces a cleaner 400.
    if not req.job_id or "/" in req.job_id or "\\" in req.job_id or ".." in req.job_id:
        raise HTTPException(status_code=400, detail="Invalid job_id")

    if req.views:
        unknown = [v for v in req.views if v not in KNOWN_CRITIQUE_VIEWS]
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown view(s): {unknown}; valid: {list(KNOWN_CRITIQUE_VIEWS)}",
            )

    try:
        result = critique_renders_by_job(
            req.job_id,
            artifacts_root=ARTIFACTS_DIR,
            views=req.views,
            max_tokens=req.max_tokens,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 -- agent itself is best-effort
        logger.exception("critique_renders failed")
        raise HTTPException(status_code=500, detail=f"Critique error: {exc}") from exc

    logger.info(
        "critique_renders: job=%s views=%d backend=%s avg_score=%s duration=%.2fs",
        result.job_id,
        len(result.critiques),
        result.backend,
        f"{result.average_score:.2f}" if result.average_score is not None else "n/a",
        result.duration_s,
    )
    return result


# ---------------------------------------------------------------------------
# Autonomous refinement loop
# ---------------------------------------------------------------------------


class RefinePlanRequest(BaseModel):
    """Re-run the architect with a previous brief + a VLM critique.

    Stateless: the client passes everything the server needs. The
    response includes ``IterationMeta`` so the editor can chain
    iterations into a v1 -> v2 -> v3 history without server-side state.
    """

    intake: GenerateHouseRequest
    previous_brief: ArchitectBrief
    critique: RendersCritique
    iteration: int = 2
    # If the previous critique's ``average_score`` is at or above this
    # threshold, we skip the LLM call and return the existing plan with
    # a clear ``skip_reason``. Set ``force=true`` to refine regardless.
    min_score: float = 7.5
    force: bool = False
    # Echo of the previous_job_id so the response can carry it back
    # through ``IterationMeta`` for the client's history view.
    previous_job_id: Optional[str] = None


class RefinePlanResponse(BaseModel):
    plan: Optional[FloorPlan] = None
    brief: Optional[ArchitectBrief] = None
    refined: bool
    iteration: int
    previous_average_score: Optional[float] = None
    skip_reason: Optional[str] = None


@app.post("/refine_plan", response_model=RefinePlanResponse)
def refine_plan(req: RefinePlanRequest) -> RefinePlanResponse:
    iteration = max(2, int(req.iteration))
    prev_score = req.critique.average_score
    if not req.force:
        if prev_score is not None and prev_score >= req.min_score:
            logger.info(
                "refine_plan: skipping iteration=%d -- score %.2f >= threshold %.2f",
                iteration, prev_score, req.min_score,
            )
            return RefinePlanResponse(
                refined=False,
                iteration=iteration - 1,
                previous_average_score=prev_score,
                skip_reason=(
                    f"Critique score {prev_score:.2f} meets threshold "
                    f"{req.min_score:.2f}; refinement skipped. "
                    "Use force=true to refine regardless."
                ),
            )
        if prev_score is None and not (req.critique.critiques or []):
            return RefinePlanResponse(
                refined=False,
                iteration=iteration - 1,
                previous_average_score=None,
                skip_reason=(
                    "Critique payload is empty; nothing to refine against. "
                    "Run /critique_renders first."
                ),
            )

    try:
        # Re-run the style-refs pass: refs may not have changed, but we
        # already memoize at the VLM client level so this is cheap.
        style_cues = None
        if req.intake.style.refs:
            try:
                style_cues = analyze_style_refs(req.intake.style.refs)
            except Exception as exc:  # noqa: BLE001
                logger.warning("style_refs during refine raised: %s", exc)

        program = build_program_refine(
            req.intake,
            previous_brief=req.previous_brief,
            critique=req.critique,
            iteration=iteration,
            style_cues=style_cues,
        )
        brief = write_brief(req.intake, program)
        if style_cues is not None:
            brief.styleCues = style_cues

        # Surface the recurring issues we tried to address into IterationMeta.
        addressed: List[str] = []
        for c in req.critique.critiques or []:
            if c.error:
                continue
            for i in c.issues[:3]:
                if i and i not in addressed:
                    addressed.append(i)
        brief.iteration = IterationMeta(
            iteration=iteration,
            previous_job_id=req.previous_job_id,
            previous_average_score=prev_score,
            addressed_issues=addressed[:8],
        )

        plan = solve_floorplan(req.intake, program)
        # Asset retrieval also runs on refined plans -- the v2 plan has
        # different room sizes so furniture dimensions changed and may
        # match different (or new) catalog entries.
        try:
            asset_matched, asset_total = enrich_with_assets(plan, style_cues=style_cues)
        except Exception as exc:  # noqa: BLE001
            logger.warning("asset_retrieval (refine) raised: %s", exc)
            asset_matched, asset_total = 0, len(plan.furniture)
        brief.codeIssues = review_plan(plan)

        logger.info(
            "refine_plan: iteration=%d source=%s prev_score=%s rooms=%d issues=%d assets=%d/%d",
            iteration,
            program.source,
            f"{prev_score:.2f}" if prev_score is not None else "n/a",
            len(plan.rooms),
            len(brief.codeIssues),
            asset_matched,
            asset_total,
        )

        return RefinePlanResponse(
            plan=plan,
            brief=brief,
            refined=True,
            iteration=iteration,
            previous_average_score=prev_score,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("refine_plan failed")
        raise HTTPException(status_code=500, detail=f"Refinement failure: {exc}") from exc


@app.post("/generate_house", response_model=GenerateHouseResponse)
def generate_house(req: GenerateHouseRequest) -> GenerateHouseResponse:
    try:
        # Style-refs analysis: best-effort VLM pass over the user's
        # uploaded inspiration photos. Returns None when no refs were
        # provided OR no VLM backend is configured. Never raises -- any
        # internal error becomes a warning on the resulting analysis.
        style_cues = None
        if req.style.refs:
            try:
                style_cues = analyze_style_refs(req.style.refs)
            except Exception as exc:  # noqa: BLE001 -- never fail the whole request
                logger.warning("style_refs analysis raised: %s: %s", type(exc).__name__, exc)
                style_cues = None

        program = build_program(req, style_cues=style_cues)
        brief = write_brief(req, program)
        if style_cues is not None:
            brief.styleCues = style_cues
            if style_cues.backend:
                brief.warnings.append(
                    f"VLM style analysis: {style_cues.backend}"
                    + (f" ({style_cues.model})" if style_cues.model else "")
                )
            for w in style_cues.warnings:
                brief.warnings.append(w)
        plan = solve_floorplan(req, program)
        # Asset retrieval: walk furniture items, assign GLB paths from
        # the catalog when matches exist. Items that don't match stay
        # parametric in the Blender shell builder (per-item fallback).
        try:
            asset_matched, asset_total = enrich_with_assets(plan, style_cues=style_cues)
        except Exception as exc:  # noqa: BLE001 -- never block on retrieval
            logger.warning("asset_retrieval raised: %s", exc)
            asset_matched, asset_total = 0, len(plan.furniture)
        # Code/zoning agent: deterministic IRC pass over the generated plan.
        # Findings are attached to the brief so the editor can surface them.
        brief.codeIssues = review_plan(plan)
        n_err = sum(1 for i in brief.codeIssues if i.severity == "error")
        n_warn = sum(1 for i in brief.codeIssues if i.severity == "warning")
        n_info = sum(1 for i in brief.codeIssues if i.severity == "info")
        logger.info(
            "generate_house: style=%s sqft=%.0f rooms=%d walls=%d openings=%d furniture=%d "
            "source=%s code_issues=%d (E%d/W%d/I%d) refs=%d cues_archetype=%s assets=%d/%d",
            plan.meta.style,
            plan.meta.sqft,
            len(plan.rooms),
            len(plan.walls),
            len(plan.openings),
            len(plan.furniture),
            plan.meta.source,
            len(brief.codeIssues),
            n_err,
            n_warn,
            n_info,
            len(req.style.refs or []),
            style_cues.archetype if style_cues else None,
            asset_matched,
            asset_total,
        )
        return GenerateHouseResponse(plan=plan, brief=brief)
    except Exception as exc:  # noqa: BLE001 - we want to surface clean errors
        logger.exception("generate_house failed")
        raise HTTPException(status_code=500, detail=f"Pipeline failure: {exc}") from exc


# ---------------------------------------------------------------------------
# VLM (Vision Language Model) endpoint
# ---------------------------------------------------------------------------


class VLMAnalyzeRequest(BaseModel):
    """Analyze a reference image for architectural style cues."""
    image_b64: str
    prompt: Optional[str] = None
    mime_type: str = "image/jpeg"
    max_tokens: int = 500


class VLMAnalyzeResponse(BaseModel):
    text: str
    model: str
    backend: str
    tokens_used: Optional[int] = None


@app.post("/vlm/analyze", response_model=VLMAnalyzeResponse)
def vlm_analyze(req: VLMAnalyzeRequest) -> VLMAnalyzeResponse:
    client = get_vlm_client()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="No VLM backend configured. Set GENESIS_VLM_BACKEND=fastvlm "
            "or GENESIS_VLM_BACKEND=openai with appropriate credentials.",
        )
    from ..vlm import STYLE_ANALYSIS_PROMPT

    prompt = req.prompt or STYLE_ANALYSIS_PROMPT
    try:
        result = client.analyze_image_base64(
            req.image_b64,
            prompt,
            mime_type=req.mime_type,
            max_tokens=req.max_tokens,
        )
        return VLMAnalyzeResponse(
            text=result.text,
            model=result.model,
            backend=result.backend,
            tokens_used=result.tokens_used,
        )
    except Exception as exc:
        logger.exception("VLM analysis failed")
        raise HTTPException(status_code=500, detail=f"VLM error: {exc}") from exc
