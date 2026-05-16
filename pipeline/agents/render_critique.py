"""Cycles render critique agent.

Closes the iterative-refinement loop: after ``/render_views`` produces
photoreal hero PNGs, this agent runs each view through the VLM (default
Apple FastVLM on-device, or any OpenAI-compatible vision endpoint) with
an architect-quality critique prompt and returns structured per-view
findings + an aggregated score.

Two modes of operation:

1. **By job_id** (preferred) -- the agent walks the per-job artifacts
   directory, picks up every ``render_<view>.png`` it finds, and runs
   them all. This is the path the front-end uses after a successful
   ``/render_views`` call -- the editor already has the ``job_id``.

2. **By absolute paths** -- pass a list of (view, path) pairs directly.
   Used by tests and any out-of-band tooling.

Like ``style_refs``, this is best-effort: any per-view failure becomes
a populated ``error`` field on that ``RenderCritique`` and a single
warning on the aggregate. The agent never raises -- /critique_renders
returns a clean 200 with warnings instead of a 500.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import time
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple

from ..schemas import RenderCritique, RendersCritique
from ..vlm import RENDER_VIEW_LABELS, render_critique_prompt, get_vlm_client


logger = logging.getLogger("genesis.pipeline.render_critique")


# Match the ``render_<view>.png`` files that ``blender_render.py``
# emits. The view name is the suffix between the prefix and the extension.
_RENDER_FILE_RE = re.compile(r"^render_(?P<view>[a-z][a-z0-9_]*)\.png$", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _coerce_json(text: str) -> dict:
    """Pull the first JSON object out of a possibly-noisy VLM response.

    Identical to ``style_refs._coerce_json`` -- duplicated here to keep
    the agents independent (no cross-agent imports), and because the
    parser is small and stable.
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("empty VLM response")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        try:
            return json.loads("\n".join(lines))
        except json.JSONDecodeError:
            pass
    start = text.find("{")
    end = text.rfind("}")
    if 0 <= start < end:
        return json.loads(text[start : end + 1])
    raise ValueError("VLM response did not contain a JSON object")


def _as_str_list(v, *, max_items: int) -> List[str]:
    """Coerce a value into a clean string list, capped at ``max_items``."""
    if v is None:
        return []
    if isinstance(v, str):
        # Split a single sentence into a one-element list. The VLM is
        # asked for arrays but occasionally returns a paragraph.
        s = v.strip()
        return [s][:max_items] if s else []
    if isinstance(v, (list, tuple)):
        out: List[str] = []
        for item in v:
            if isinstance(item, str):
                cleaned = item.strip(" .,;:")
                if cleaned:
                    out.append(cleaned)
            elif item is not None:
                cleaned = str(item).strip(" .,;:")
                if cleaned:
                    out.append(cleaned)
            if len(out) >= max_items:
                break
        return out
    s = str(v).strip()
    return [s][:max_items] if s else []


def _coerce_score(v) -> Optional[float]:
    """Map a model-provided score value to a clamped float in [1.0, 10.0]."""
    if v is None:
        return None
    try:
        score = float(v)
    except (TypeError, ValueError):
        # Sometimes the VLM returns "8/10" or "Score: 7" -- pull the first number.
        m = re.search(r"[-+]?\d*\.?\d+", str(v))
        if not m:
            return None
        try:
            score = float(m.group(0))
        except ValueError:
            return None
    # Common case: model returns 0-1 scale. Map to 1-10 if so.
    if 0.0 <= score <= 1.0 and score not in (0.0, 1.0):
        score = score * 10.0
    return max(1.0, min(10.0, score))


def _parse_critique_payload(payload: dict, *, view: str, url: Optional[str]) -> RenderCritique:
    summary = payload.get("summary")
    if isinstance(summary, list):
        summary = ", ".join(str(s) for s in summary if s) or None
    elif isinstance(summary, str):
        summary = summary.strip() or None
        if summary and len(summary) > 240:
            summary = summary[:237] + "..."
    else:
        summary = None

    return RenderCritique(
        view=view,
        url=url,
        strengths=_as_str_list(payload.get("strengths"), max_items=3),
        issues=_as_str_list(payload.get("issues"), max_items=3),
        suggestions=_as_str_list(payload.get("suggestions"), max_items=2),
        score=_coerce_score(payload.get("score") or payload.get("rating")),
        summary=summary,
    )


def _detect_mime(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in (".jpg", ".jpeg"):
        return "image/jpeg"
    if suffix == ".webp":
        return "image/webp"
    return "image/png"


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def discover_renders(job_dir: Path) -> List[Tuple[str, Path]]:
    """Return ``(view, absolute_path)`` for every render under ``job_dir``."""
    if not job_dir.is_dir():
        return []
    out: List[Tuple[str, Path]] = []
    for entry in sorted(job_dir.iterdir()):
        m = _RENDER_FILE_RE.match(entry.name)
        if not m:
            continue
        out.append((m.group("view"), entry.resolve()))
    return out


# ---------------------------------------------------------------------------
# Per-image VLM call
# ---------------------------------------------------------------------------


def _critique_one(client, view: str, path: Path, *, max_tokens: int) -> RenderCritique:  # type: ignore[no-untyped-def]
    """Read ``path`` and run a single VLM critique. Raises on failure."""
    if not path.is_file():
        raise FileNotFoundError(f"render not found: {path}")
    data = path.read_bytes()
    if not data:
        raise RuntimeError("empty render bytes")
    b64 = base64.b64encode(data).decode("ascii")
    prompt = render_critique_prompt(view)
    result = client.analyze_image_base64(
        b64,
        prompt,
        mime_type=_detect_mime(path),
        max_tokens=max_tokens,
    )
    payload = _coerce_json(result.text)
    return _parse_critique_payload(payload, view=view, url=None)


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def _aggregate_score(critiques: Sequence[RenderCritique]) -> Optional[float]:
    scores = [c.score for c in critiques if c.score is not None and c.error is None]
    if not scores:
        return None
    return round(sum(scores) / len(scores), 2)


def _aggregate_summary(critiques: Sequence[RenderCritique]) -> Optional[str]:
    """Build a deterministic one-paragraph synthesis without a second VLM call."""
    successful = [c for c in critiques if c.error is None]
    if not successful:
        return None

    score = _aggregate_score(critiques)
    n = len(successful)

    # Verdict tier from the average score.
    if score is None:
        tier = "mixed"
    elif score >= 8.5:
        tier = "strong"
    elif score >= 7.0:
        tier = "solid with refinements possible"
    elif score >= 5.5:
        tier = "promising but needs work"
    else:
        tier = "rough -- significant rework recommended"

    # Pull the most-cited issues across all views (frequency-ranked).
    issue_counts: dict[str, int] = {}
    for c in successful:
        for i in c.issues:
            key = i.strip().lower()
            if key:
                issue_counts[key] = issue_counts.get(key, 0) + 1
    top_issues: List[str] = []
    if issue_counts:
        ordered = sorted(issue_counts.items(), key=lambda kv: -kv[1])
        # Pick original-cased version of the top entries.
        for key, _ in ordered[:3]:
            for c in successful:
                for i in c.issues:
                    if i.strip().lower() == key:
                        top_issues.append(i)
                        break
                if top_issues and top_issues[-1].strip().lower() == key:
                    break

    parts: List[str] = []
    parts.append(
        f"Across {n} view{'s' if n != 1 else ''}, the home reads as {tier}"
        + (f" (avg {score:.1f}/10)." if score is not None else ".")
    )
    if top_issues:
        parts.append("Recurring concerns: " + "; ".join(top_issues) + ".")
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


def critique_renders_for_paths(
    job_id: str,
    pairs: Sequence[Tuple[str, Path]],
    *,
    artifacts_root: Path,
    max_views: int = 4,
    max_tokens: int = 500,
) -> RendersCritique:
    """Run the VLM critique against an explicit ``(view, path)`` list.

    ``artifacts_root`` is used to compute relative URLs for the response
    so the front-end can keep linking the same ``/artifacts/...`` path
    that ``/render_views`` originally returned.
    """

    started = time.monotonic()
    client = get_vlm_client()
    if client is None:
        return RendersCritique(
            job_id=job_id,
            critiques=[
                RenderCritique(view=v, url=_relative_artifact_url(artifacts_root, p))
                for v, p in pairs[:max_views]
            ],
            warnings=[
                "No VLM backend configured; renders were not critiqued. "
                "Set GENESIS_VLM_BACKEND=fastvlm (Apple Silicon) or "
                "GENESIS_VLM_BACKEND=openai with credentials to enable.",
            ],
            duration_s=round(time.monotonic() - started, 3),
        )

    targets = list(pairs)[:max_views]
    skipped = max(0, len(pairs) - len(targets))
    critiques: List[RenderCritique] = []
    warnings: List[str] = []

    for view, path in targets:
        url = _relative_artifact_url(artifacts_root, path)
        try:
            critique = _critique_one(client, view, path, max_tokens=max_tokens)
            critique.url = url
            critiques.append(critique)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "render_critique: failed for %s (%s): %s",
                view, path, exc,
            )
            critiques.append(RenderCritique(
                view=view,
                url=url,
                error=f"{type(exc).__name__}: {exc}",
            ))
            warnings.append(f"Critique failed for {view}: {type(exc).__name__}")

    if skipped > 0:
        warnings.append(
            f"Only critiqued first {max_views} of {len(pairs)} renders to keep latency bounded."
        )

    backend_name: Optional[str] = None
    model_name: Optional[str] = None
    try:
        cls = type(client).__name__
        if "FastVLM" in cls:
            backend_name = "fastvlm"
        elif "OpenAI" in cls:
            backend_name = "openai"
        model_name = getattr(client, "model_name", None) or getattr(client, "model", None)
    except Exception:  # pragma: no cover
        pass

    return RendersCritique(
        job_id=job_id,
        critiques=critiques,
        average_score=_aggregate_score(critiques),
        overall_summary=_aggregate_summary(critiques),
        backend=backend_name,
        model=model_name,
        duration_s=round(time.monotonic() - started, 3),
        warnings=warnings,
    )


def critique_renders_by_job(
    job_id: str,
    *,
    artifacts_root: Path,
    views: Optional[Sequence[str]] = None,
    max_views: int = 4,
    max_tokens: int = 500,
) -> RendersCritique:
    """Critique every (or a filtered subset of) renders under a job dir."""

    job_dir = (artifacts_root / job_id).resolve()
    # Defense in depth: never read outside the artifacts root.
    if artifacts_root not in job_dir.parents and job_dir != artifacts_root:
        raise ValueError(f"job_id escapes artifacts root: {job_id!r}")

    pairs = discover_renders(job_dir)
    if views:
        wanted = {v for v in views}
        pairs = [(v, p) for v, p in pairs if v in wanted]

    if not pairs:
        return RendersCritique(
            job_id=job_id,
            critiques=[],
            warnings=[
                f"No render PNGs found under {job_dir}. Run /render_views first.",
            ],
        )

    return critique_renders_for_paths(
        job_id, pairs,
        artifacts_root=artifacts_root,
        max_views=max_views,
        max_tokens=max_tokens,
    )


def _relative_artifact_url(artifacts_root: Path, path: Path) -> str:
    """Build the ``/artifacts/<job_id>/render_<view>.png`` URL for a path."""
    try:
        rel = path.resolve().relative_to(artifacts_root.resolve())
    except ValueError:
        return path.name
    # Use forward slashes regardless of OS so the URL is consistent.
    return "/artifacts/" + "/".join(rel.parts)


# Re-export view labels so the front-end can pull a friendly name without
# duplicating the table on the React side (it already knows view ids).
KNOWN_VIEWS: Tuple[str, ...] = tuple(RENDER_VIEW_LABELS.keys())
