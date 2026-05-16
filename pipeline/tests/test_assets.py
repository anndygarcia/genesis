"""Unit tests for the asset catalog loader and retrieval scorer."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

from pipeline.assets import (
    AssetCatalog,
    AssetEntry,
    _coerce_entry,
    _dim_proximity,
    _style_bonus,
    get_default_catalog,
    reset_default_catalog,
    score_asset,
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


# ---------------------------------------------------------------------------
# _coerce_entry
# ---------------------------------------------------------------------------


def test_coerce_minimal(tmp_path: Path) -> None:
    glb = _fake_glb(tmp_path, "sofa")
    raw = {"id": "sofa-1", "kind": "sofa", "path": str(glb.name), "dimensions": [2.0, 0.8, 0.9]}
    entry = _coerce_entry(raw, manifest_dir=tmp_path)
    assert entry is not None
    assert entry.id == "sofa-1"
    assert entry.kind == "sofa"
    assert entry.dimensions == (2.0, 0.8, 0.9)


def test_coerce_bad_dimensions(tmp_path: Path) -> None:
    raw = {"id": "x", "kind": "sofa", "path": "a.glb", "dimensions": [1, 2]}
    assert _coerce_entry(raw, manifest_dir=tmp_path) is None


def test_coerce_missing_file_skipped(tmp_path: Path) -> None:
    raw = {"id": "x", "kind": "sofa", "path": "missing.glb", "dimensions": [1, 1, 1]}
    cat = AssetCatalog.load(_make_manifest(tmp_path, [raw]))
    assert cat.is_empty()


# ---------------------------------------------------------------------------
# _dim_proximity
# ---------------------------------------------------------------------------


def test_dim_proximity_perfect() -> None:
    assert _dim_proximity([1.0, 1.0, 1.0], [1.0, 1.0, 1.0]) == pytest.approx(1.0)


def test_dim_proximity_mismatch() -> None:
    assert _dim_proximity([2.0, 1.0, 1.0], [1.0, 1.0, 1.0]) == pytest.approx(0.5 ** 1.4)


def test_dim_proximity_zero_axis() -> None:
    assert _dim_proximity([0.0, 1.0, 1.0], [1.0, 1.0, 1.0]) == 0.0


def test_dim_proximity_30pct_off() -> None:
    # 0.7 ratio per axis => 0.7**1.4 per axis, cubed => ~0.22 total
    score = _dim_proximity([1.0, 1.0, 1.0], [0.7, 0.7, 0.7])
    assert score == pytest.approx(0.7 ** (3 * 1.4), abs=0.01)
    assert 0.2 < score < 0.25


# ---------------------------------------------------------------------------
# _style_bonus
# ---------------------------------------------------------------------------


def test_style_bonus_no_request() -> None:
    assert _style_bonus([], ["modern"]) == 0.0


def test_style_bonus_no_asset_tags() -> None:
    assert _style_bonus(["modern"], []) == 0.0


def test_style_bonus_exact() -> None:
    # bonus is clamped to 0.5 max
    assert _style_bonus(["modern", "industrial"], ["modern", "industrial"]) == pytest.approx(0.5)
    assert _style_bonus(["modern", "industrial"], ["modern"]) == pytest.approx(0.5)


def test_style_bonus_clamped() -> None:
    # intersection 2 / req 2 => 1.0 but clamped to 0.5 max
    assert _style_bonus(["a", "b"], ["a", "b"]) == pytest.approx(0.5)


# ---------------------------------------------------------------------------
# score_asset
# ---------------------------------------------------------------------------


def test_score_asset_kind_mismatch() -> None:
    entry = AssetEntry(id="x", kind="sofa", path="a.glb", dimensions=(1, 1, 1))
    assert score_asset(entry, kind="bed", target_dimensions=[1, 1, 1]) == 0.0


def test_score_asset_zero_prox() -> None:
    entry = AssetEntry(id="x", kind="sofa", path="a.glb", dimensions=(0.1, 0.1, 0.1))
    s = score_asset(entry, kind="sofa", target_dimensions=[2, 1, 1])
    # Very small dimensions produce a non-zero but tiny score; it should be well below min_score.
    assert 0.0 < s < 0.01


def test_score_asset_good_match() -> None:
    entry = AssetEntry(id="x", kind="sofa", path="a.glb", dimensions=(2.0, 0.8, 0.9))
    s = score_asset(entry, kind="sofa", target_dimensions=[2.0, 0.8, 0.9])
    assert s == pytest.approx(1.0, abs=0.01)


def test_score_asset_with_style_bonus() -> None:
    entry = AssetEntry(
        id="x", kind="sofa", path="a.glb", dimensions=(2.0, 0.8, 0.9), style_tags=("modern", "minimal")
    )
    s = score_asset(entry, kind="sofa", target_dimensions=[2.0, 0.8, 0.9], style_tags=["modern"])
    # prox=1, bonus=0.5 (clamped) => 1.5
    assert s == pytest.approx(1.5, abs=0.01)


# ---------------------------------------------------------------------------
# AssetCatalog.load / load_default
# ---------------------------------------------------------------------------


def test_load_empty_manifest(tmp_path: Path) -> None:
    p = tmp_path / "manifest.json"
    p.write_text(json.dumps({"version": 1, "assets": []}), encoding="utf-8")
    cat = AssetCatalog.load(p)
    assert cat.is_empty()


def test_load_missing_manifest(tmp_path: Path) -> None:
    cat = AssetCatalog.load(tmp_path / "nope.json")
    assert cat.is_empty()


def test_load_bad_version(tmp_path: Path) -> None:
    p = tmp_path / "manifest.json"
    p.write_text(json.dumps({"version": 99, "assets": []}), encoding="utf-8")
    cat = AssetCatalog.load(p)
    assert cat.is_empty()


def test_load_filters_missing_files(tmp_path: Path) -> None:
    glb = _fake_glb(tmp_path, "keep")
    cat = AssetCatalog.load(
        _make_manifest(
            tmp_path,
            [
                {"id": "a", "kind": "sofa", "path": str(glb.name), "dimensions": [1, 1, 1]},
                {"id": "b", "kind": "bed", "path": "missing.glb", "dimensions": [1, 1, 1]},
            ],
        )
    )
    assert len(cat.entries) == 1
    assert cat.entries[0].id == "a"


# ---------------------------------------------------------------------------
# AssetCatalog.best_match
# ---------------------------------------------------------------------------


def test_best_match_empty_catalog() -> None:
    cat = AssetCatalog(entries=[])
    assert cat.best_match("sofa", [2, 1, 1]) is None


def test_best_match_tie_breaker(tmp_path: Path) -> None:
    glb1 = _fake_glb(tmp_path, "sofa1")
    glb2 = _fake_glb(tmp_path, "sofa2")
    cat = AssetCatalog.load(
        _make_manifest(
            tmp_path,
            [
                {"id": "exact", "kind": "sofa", "path": str(glb1.name), "dimensions": [2.0, 1.0, 1.0]},
                {"id": "off", "kind": "sofa", "path": str(glb2.name), "dimensions": [1.0, 1.0, 1.0]},
            ],
        )
    )
    winner = cat.best_match("sofa", [2.0, 1.0, 1.0])
    assert winner is not None
    assert winner.id == "exact"


def test_best_match_min_score(tmp_path: Path) -> None:
    glb = _fake_glb(tmp_path, "sofa")
    cat = AssetCatalog.load(
        _make_manifest(
            tmp_path,
            [{"id": "x", "kind": "sofa", "path": str(glb.name), "dimensions": [0.1, 0.1, 0.1]}],
        )
    )
    assert cat.best_match("sofa", [2, 1, 1], min_score=0.5) is None


def test_best_match_style_bias(tmp_path: Path) -> None:
    glb1 = _fake_glb(tmp_path, "sofa1")
    glb2 = _fake_glb(tmp_path, "sofa2")
    cat = AssetCatalog.load(
        _make_manifest(
            tmp_path,
            [
                {"id": "plain", "kind": "sofa", "path": str(glb1.name), "dimensions": [2.0, 1.0, 1.0]},
                {
                    "id": "styled",
                    "kind": "sofa",
                    "path": str(glb2.name),
                    "dimensions": [2.0, 1.0, 1.0],
                    "style_tags": ["industrial"],
                },
            ],
        )
    )
    winner = cat.best_match("sofa", [2.0, 1.0, 1.0], style_tags=["industrial"])
    assert winner is not None
    assert winner.id == "styled"


# ---------------------------------------------------------------------------
# get_default_catalog caching
# ---------------------------------------------------------------------------


def test_default_catalog_cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    reset_default_catalog()
    glb = _fake_glb(tmp_path, "x")
    manifest = _make_manifest(tmp_path, [{"id": "x", "kind": "sofa", "path": str(glb.name), "dimensions": [1, 1, 1]}])
    monkeypatch.setenv("GENESIS_ASSET_LIBRARY", str(manifest))
    cat1 = get_default_catalog()
    cat2 = get_default_catalog()
    assert cat1 is cat2
    reset_default_catalog()


# ---------------------------------------------------------------------------
# TRELLIS fetcher
# ---------------------------------------------------------------------------


def test_fetch_trellis_unconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    from pipeline.assets import fetch_trellis_asset

    monkeypatch.delenv("GENESIS_TRELLIS_ENDPOINT", raising=False)
    assert fetch_trellis_asset("sofa", [2.0, 0.9, 0.85]) is None
