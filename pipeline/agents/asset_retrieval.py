"""Asset retrieval agent.

Walks every ``FurnitureItem`` in a ``FloorPlan`` and assigns
``assetPath`` / ``assetId`` from the asset catalog when a confident
match exists. Operates *in place* on the plan so the rest of the
pipeline (Blender shell builder, Cycles renderer) can read the asset
fields directly without an additional round-trip.

Match policy:
  * kind must match exactly
  * dimension proximity (Gaussian-ish) must clear ``min_score``
  * style tags from the architect's archetype + (optionally) FastVLM
    style cues add up to a 50% bonus

When the catalog is empty or no entry matches a given item, that item
is left untouched and the parametric builder takes over for it. This
is a per-item upgrade, never an all-or-nothing swap.
"""

from __future__ import annotations

import logging
from typing import List, Optional, Sequence, Tuple

from ..assets import AssetCatalog, get_default_catalog
from ..schemas import FloorPlan, StyleAnalysis


logger = logging.getLogger("genesis.pipeline.asset_retrieval")


def _style_tags_for(plan: FloorPlan, *, style_cues: Optional[StyleAnalysis]) -> Tuple[str, ...]:
    """Combine architect-style + (optional) VLM-style hints into a tag list."""
    tags: List[str] = []
    if plan.meta.style:
        tags.append(plan.meta.style.strip().lower())
    if style_cues:
        if style_cues.archetype:
            tags.append(style_cues.archetype.strip().lower())
        # The VLM material list often contains adjectives that align with
        # archetype tags too (e.g. "industrial metal" -> "industrial").
        for m in style_cues.materials[:4]:
            tags.append(m.strip().lower())
    # De-dup while preserving order.
    seen: dict[str, None] = {}
    out: List[str] = []
    for t in tags:
        if t and t not in seen:
            seen[t] = None
            out.append(t)
    return tuple(out)


def enrich_with_assets(
    plan: FloorPlan,
    *,
    style_cues: Optional[StyleAnalysis] = None,
    catalog: Optional[AssetCatalog] = None,
    min_score: float = 0.20,
) -> Tuple[int, int]:
    """Assign asset paths to every furniture item that finds a confident match.

    Returns ``(matched, total)``. Operates in place; the same FloorPlan
    object is returned via mutation. Always succeeds, even if the catalog
    is empty -- the parametric fallback handles unmatched items downstream.
    """
    cat = catalog if catalog is not None else get_default_catalog()
    total = len(plan.furniture)
    if cat.is_empty() or total == 0:
        if cat.is_empty():
            logger.debug(
                "Asset catalog empty (manifest=%s); furniture stays parametric.",
                cat.manifest_path,
            )
        return 0, total

    style_tags = _style_tags_for(plan, style_cues=style_cues)
    matched = 0

    for item in plan.furniture:
        # Don't overwrite an already-assigned asset (lets manual editor
        # overrides survive a re-enrichment pass).
        if item.assetPath:
            matched += 1
            continue

        # Use the FurnitureItem's `scale` as the target dimensions. The
        # scale tuple is (width, height_y, depth) in meters per the
        # FloorPlan schema, which is exactly what AssetCatalog expects.
        try:
            target_dims: Sequence[float] = (
                float(item.scale[0]),
                float(item.scale[1]),
                float(item.scale[2]),
            )
        except (TypeError, ValueError, IndexError):
            continue

        entry = cat.best_match(
            item.kind,
            target_dims,
            style_tags=style_tags,
            min_score=min_score,
        )
        if entry is None:
            continue
        item.assetPath = entry.path
        item.assetId = entry.id
        matched += 1

    if total > 0:
        logger.info(
            "asset_retrieval: matched %d/%d furniture items (catalog=%d entries, style_tags=%s)",
            matched, total, len(cat.entries), list(style_tags),
        )
    return matched, total
