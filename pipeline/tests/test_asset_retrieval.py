"""Unit tests for the asset-retrieval agent (enrich_with_assets)."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from pipeline.agents.asset_retrieval import enrich_with_assets
from pipeline.assets import AssetCatalog, AssetEntry, reset_default_catalog
from pipeline.schemas import (
    FloorPlan,
    FloorPlanMeta,
    FurnitureItem,
    Room,
    StyleAnalysis,
    Vec2,
    Wall,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_manifest(tmpdir: Path, assets: list[dict]) -> Path:
    path = tmpdir / "manifest.json"
    path.write_text(json.dumps({"version": 1, "assets": assets}), encoding="utf-8")
    return path


def _fake_glb(tmpdir: Path, name: str) -> Path:
    p = tmpdir / f"{name}.glb"
    p.write_bytes(b"fake")
    return p


def _simple_plan(*furniture: FurnitureItem) -> FloorPlan:
    room = Room(id="r1", kind="living_room", name="Living", min=Vec2(x=0, z=0), max=Vec2(x=5, z=5))
    return FloorPlan(
        meta=FloorPlanMeta(style="modern", sqft=1000, floors=1, generatedAt="2024-01-01T00:00:00Z", seed=1),
        rooms=[room],
        walls=[
            Wall(id="w1", a=Vec2(x=0, z=0), b=Vec2(x=5, z=0)),
            Wall(id="w2", a=Vec2(x=5, z=0), b=Vec2(x=5, z=5)),
            Wall(id="w3", a=Vec2(x=5, z=5), b=Vec2(x=0, z=5)),
            Wall(id="w4", a=Vec2(x=0, z=5), b=Vec2(x=0, z=0)),
        ],
        openings=[],
        furniture=list(furniture),
    )


def _sofa(room_id: str = "r1", scale: tuple[float, float, float] = (2.0, 0.9, 0.85)) -> FurnitureItem:
    return FurnitureItem(
        id="f1", kind="sofa", name="Sofa", roomId=room_id,
        position=(1.0, 0.0, 1.0), rotation=(0, 0, 0), scale=scale,
    )


def _bed(room_id: str = "r1", scale: tuple[float, float, float] = (1.6, 2.0, 0.6)) -> FurnitureItem:
    return FurnitureItem(
        id="f2", kind="bed", name="Bed", roomId=room_id,
        position=(3.0, 0.0, 3.0), rotation=(0, 0, 0), scale=scale,
    )


# ---------------------------------------------------------------------------
# enrich_with_assets
# ---------------------------------------------------------------------------


def test_enrich_empty_catalog() -> None:
    plan = _simple_plan(_sofa())
    matched, total = enrich_with_assets(plan, catalog=AssetCatalog(entries=[]))
    assert matched == 0
    assert total == 1
    assert plan.furniture[0].assetPath is None


def test_enrich_no_furniture() -> None:
    plan = _simple_plan()
    matched, total = enrich_with_assets(plan, catalog=AssetCatalog(entries=[]))
    assert matched == 0
    assert total == 0


def test_enrich_exact_match(tmp_path: Path) -> None:
    glb = _fake_glb(tmp_path, "sofa")
    cat = AssetCatalog.load(
        _make_manifest(
            tmp_path,
            [{"id": "sofa-01", "kind": "sofa", "path": str(glb.name), "dimensions": [2.0, 0.9, 0.85]}],
        )
    )
    plan = _simple_plan(_sofa(scale=(2.0, 0.9, 0.85)))
    matched, total = enrich_with_assets(plan, catalog=cat)
    assert matched == 1
    assert total == 1
    assert plan.furniture[0].assetPath == str(glb.resolve())
    assert plan.furniture[0].assetId == "sofa-01"


def test_enrich_preserves_existing_asset(tmp_path: Path) -> None:
    """Items that already have assetPath must not be overwritten."""
    glb = _fake_glb(tmp_path, "sofa")
    cat = AssetCatalog.load(
        _make_manifest(
            tmp_path,
            [{"id": "sofa-01", "kind": "sofa", "path": str(glb.name), "dimensions": [2.0, 0.9, 0.85]}],
        )
    )
    item = _sofa()
    item.assetPath = "/already/assigned.glb"
    item.assetId = "manual"
    plan = _simple_plan(item)
    matched, total = enrich_with_assets(plan, catalog=cat)
    assert matched == 1
    assert total == 1
    assert plan.furniture[0].assetPath == "/already/assigned.glb"
    assert plan.furniture[0].assetId == "manual"


def test_enrich_partial_match(tmp_path: Path) -> None:
    """Only items that find a catalog entry get upgraded; others stay parametric."""
    glb = _fake_glb(tmp_path, "sofa")
    cat = AssetCatalog.load(
        _make_manifest(
            tmp_path,
            [{"id": "sofa-01", "kind": "sofa", "path": str(glb.name), "dimensions": [2.0, 0.9, 0.85]}],
        )
    )
    plan = _simple_plan(_sofa(), _bed())
    matched, total = enrich_with_assets(plan, catalog=cat)
    assert matched == 1
    assert total == 2
    assert plan.furniture[0].assetPath is not None
    assert plan.furniture[1].assetPath is None


def test_enrich_style_tags_boost(tmp_path: Path) -> None:
    glb1 = _fake_glb(tmp_path, "sofa_modern")
    glb2 = _fake_glb(tmp_path, "sofa_plain")
    cat = AssetCatalog.load(
        _make_manifest(
            tmp_path,
            [
                {
                    "id": "plain",
                    "kind": "sofa",
                    "path": str(glb2.name),
                    "dimensions": [2.0, 0.9, 0.85],
                },
                {
                    "id": "modern",
                    "kind": "sofa",
                    "path": str(glb1.name),
                    "dimensions": [2.0, 0.9, 0.85],
                    "style_tags": ["modern"],
                },
            ],
        )
    )
    plan = _simple_plan(_sofa())
    style = StyleAnalysis(archetype="modern")
    matched, total = enrich_with_assets(plan, catalog=cat, style_cues=style)
    assert matched == 1
    assert plan.furniture[0].assetId == "modern"


def test_enrich_bad_scale_skipped() -> None:
    """Items with malformed scale tuples are silently skipped, not crashed."""
    item = _sofa()
    item.scale = (1.0,)  # type: ignore[assignment]
    plan = _simple_plan(item)
    matched, total = enrich_with_assets(plan, catalog=AssetCatalog(entries=[]))
    assert matched == 0
    assert total == 1


# ---------------------------------------------------------------------------
# _style_tags_for
# ---------------------------------------------------------------------------


def test_style_tags_from_plan_and_cues() -> None:
    from pipeline.agents.asset_retrieval import _style_tags_for

    plan = _simple_plan()
    cues = StyleAnalysis(archetype="industrial", materials=["metal", "concrete"])
    tags = _style_tags_for(plan, style_cues=cues)
    assert "modern" in tags  # from plan.meta.style
    assert "industrial" in tags
    assert "metal" in tags
    assert "concrete" in tags


def test_style_tags_deduped() -> None:
    from pipeline.agents.asset_retrieval import _style_tags_for

    plan = _simple_plan()
    plan.meta.style = "industrial"
    cues = StyleAnalysis(archetype="industrial", materials=["industrial"])
    tags = _style_tags_for(plan, style_cues=cues)
    assert tags.count("industrial") == 1
