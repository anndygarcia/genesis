"""Asset catalog for furniture retrieval (TRELLIS / 3D-FUTURE / CC0 packs).

Replaces parametric furniture in the Cycles renders with real glTF
meshes when matching assets are available. The contract is intentionally
small so any of these sources can plug in:

  * **Pre-curated GLB packs** (Quaternius, KayKit, Poly Pizza CC0): drop
    the GLBs into ``pipeline/assets/library/`` and add an entry to
    ``pipeline/assets/manifest.json``.
  * **3D-FUTURE / 3D-FRONT** (academic, large dataset): generate the
    manifest from the dataset's CSV using a small adapter script, then
    point ``GENESIS_ASSET_LIBRARY`` at the dataset root.
  * **TRELLIS HTTP endpoint** (Microsoft's structured 3D generator):
    set ``GENESIS_TRELLIS_ENDPOINT`` and the catalog will fetch
    on-demand assets at runtime, caching them locally by content hash.

The pipeline degrades gracefully: if the catalog is empty OR no asset
matches a furniture item, the parametric builder in ``blender_build.py``
takes over for that item. This is a per-item fallback, so a partially
populated catalog still works -- only the kinds with assets get the
upgrade, the rest stay parametric.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Sequence, Tuple


logger = logging.getLogger("genesis.pipeline.assets")


# Default catalog roots in resolution order. ``GENESIS_ASSET_LIBRARY``
# (env var) overrides everything; otherwise we look next to this module.
_DEFAULT_LIBRARY_DIR = Path(__file__).resolve().parent / "library"
_DEFAULT_MANIFEST_PATH = Path(__file__).resolve().parent / "manifest.json"


@dataclass(frozen=True)
class AssetEntry:
    """One row in the manifest. All fields are validated on load."""

    id: str
    kind: str
    path: str                    # absolute or relative-to-manifest path to a .glb / .gltf
    dimensions: Tuple[float, float, float]  # (width, height, depth) in meters
    style_tags: Tuple[str, ...] = ()
    license: str = "unknown"
    source: str = ""
    preview: Optional[str] = None
    # Optional bounds for fuzzy matching when the FurnitureItem's
    # dimensions don't have to match exactly. The retrieval scorer
    # tolerates ~30% off in either direction by default.
    description: Optional[str] = None


def _coerce_entry(raw: dict, *, manifest_dir: Path) -> Optional[AssetEntry]:
    try:
        path = str(raw["path"]).strip()
        dims_raw = raw.get("dimensions") or [1.0, 1.0, 1.0]
        if not isinstance(dims_raw, (list, tuple)) or len(dims_raw) != 3:
            raise ValueError(f"dimensions must be a [w,h,d] triple, got {dims_raw!r}")
        dims = tuple(float(v) for v in dims_raw)

        # Resolve the path relative to the manifest's directory unless
        # it's absolute. Don't resolve symlinks here -- we want the
        # exact string we'll pass to Blender's import_scene.gltf.
        p = Path(path)
        if not p.is_absolute():
            p = (manifest_dir / p).resolve()
        return AssetEntry(
            id=str(raw["id"]).strip(),
            kind=str(raw["kind"]).strip().lower(),
            path=str(p),
            dimensions=(dims[0], dims[1], dims[2]),
            style_tags=tuple(
                str(t).strip().lower()
                for t in (raw.get("style_tags") or [])
                if str(t).strip()
            ),
            license=str(raw.get("license") or "unknown"),
            source=str(raw.get("source") or ""),
            preview=(str(raw["preview"]) if raw.get("preview") else None),
            description=(str(raw["description"]) if raw.get("description") else None),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("asset manifest entry rejected: %s; entry=%r", exc, raw)
        return None


# ---------------------------------------------------------------------------
# Retrieval scoring
# ---------------------------------------------------------------------------
#
# Score = (kind_match) * (dimension_proximity_factor) * (1 + style_bonus)
#
#   * kind must match exactly (kind_match = 1) or the entry scores 0.
#   * dimension_proximity_factor in [0, 1] using a clamped Gaussian over
#     each axis, so a 2.2m-wide sofa request matches a 2.0m asset nearly
#     perfectly but heavily penalizes a 0.8m couch.
#   * style_bonus = (intersection / max(1, requested_tag_count)), clamped
#     to [0, 0.5]. Prevents tag-stuffed entries from outscoring better
#     fits.


def _dim_proximity(target: Sequence[float], asset: Sequence[float]) -> float:
    """Return [0, 1]; 1.0 means perfect dimension match.

    Per-axis penalty uses a Gaussian-ish curve where a 30% mismatch on
    any axis costs ~0.5 of that axis's score, and 100% mismatch (asset
    is 2x or 0.5x target) drops it near zero.
    """
    if len(target) != 3 or len(asset) != 3:
        return 0.0
    score = 1.0
    for t, a in zip(target, asset):
        if t <= 0 or a <= 0:
            return 0.0
        # symmetric ratio: 1.0 when equal, drops as they diverge
        ratio = min(t, a) / max(t, a)
        # Penalize hard when ratio < 0.5; gentle when ~0.85+.
        score *= ratio ** 1.4
    return max(0.0, min(1.0, score))


def _style_bonus(requested: Sequence[str], asset_tags: Sequence[str]) -> float:
    if not requested:
        return 0.0
    asset_set = {t.strip().lower() for t in asset_tags if t}
    if not asset_set:
        return 0.0
    req_set = {t.strip().lower() for t in requested if t}
    if not req_set:
        return 0.0
    overlap = len(req_set & asset_set)
    bonus = overlap / max(1, len(req_set))
    return max(0.0, min(0.5, bonus))


def score_asset(
    entry: AssetEntry,
    *,
    kind: str,
    target_dimensions: Sequence[float],
    style_tags: Sequence[str] = (),
) -> float:
    """Return a non-negative match score; higher is better."""
    if entry.kind != kind.strip().lower():
        return 0.0
    prox = _dim_proximity(target_dimensions, entry.dimensions)
    if prox <= 0.0:
        return 0.0
    bonus = _style_bonus(style_tags, entry.style_tags)
    return prox * (1.0 + bonus)


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------


@dataclass
class AssetCatalog:
    """A loaded asset manifest with retrieval helpers.

    Use ``AssetCatalog.load_default()`` to read from the default
    location. Tests can build a catalog in memory by passing entries
    directly to ``AssetCatalog(entries=...)``.
    """

    entries: List[AssetEntry] = field(default_factory=list)
    manifest_path: Optional[Path] = None

    @classmethod
    def load(cls, manifest_path: Path) -> "AssetCatalog":
        manifest_path = Path(manifest_path)
        if not manifest_path.is_file():
            return cls(entries=[], manifest_path=manifest_path)
        try:
            raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to parse asset manifest %s: %s", manifest_path, exc)
            return cls(entries=[], manifest_path=manifest_path)

        version = raw.get("version", 1)
        if int(version) != 1:
            logger.warning(
                "Unsupported asset manifest version %s; expected 1. Treating as empty.",
                version,
            )
            return cls(entries=[], manifest_path=manifest_path)

        entries: List[AssetEntry] = []
        for row in (raw.get("assets") or []):
            entry = _coerce_entry(row, manifest_dir=manifest_path.parent)
            if entry is None:
                continue
            # Only keep entries whose file actually exists. This keeps
            # the catalog honest -- the Blender importer will otherwise
            # fail at runtime with a less-helpful traceback.
            if not Path(entry.path).is_file():
                logger.info("Asset %s skipped: file not found at %s", entry.id, entry.path)
                continue
            entries.append(entry)

        logger.info(
            "AssetCatalog loaded: %d entries from %s",
            len(entries), manifest_path,
        )
        return cls(entries=entries, manifest_path=manifest_path)

    @classmethod
    def load_default(cls) -> "AssetCatalog":
        """Load the catalog from ``GENESIS_ASSET_LIBRARY`` or the bundled default."""
        override = os.environ.get("GENESIS_ASSET_LIBRARY", "").strip()
        if override:
            p = Path(override)
            if p.is_dir():
                p = p / "manifest.json"
            return cls.load(p)
        return cls.load(_DEFAULT_MANIFEST_PATH)

    def is_empty(self) -> bool:
        return not self.entries

    def best_match(
        self,
        kind: str,
        target_dimensions: Sequence[float],
        *,
        style_tags: Sequence[str] = (),
        min_score: float = 0.20,
    ) -> Optional[AssetEntry]:
        """Return the highest-scoring entry, or ``None`` if no entry meets ``min_score``."""
        best: Optional[Tuple[float, AssetEntry]] = None
        for entry in self.entries:
            s = score_asset(
                entry,
                kind=kind,
                target_dimensions=target_dimensions,
                style_tags=style_tags,
            )
            if s < min_score:
                continue
            if best is None or s > best[0]:
                best = (s, entry)
        return best[1] if best else None


# ---------------------------------------------------------------------------
# Process-wide cache
# ---------------------------------------------------------------------------


_default_catalog: Optional[AssetCatalog] = None


def get_default_catalog() -> AssetCatalog:
    """Return a cached catalog instance shared across the FastAPI process."""
    global _default_catalog
    if _default_catalog is None:
        _default_catalog = AssetCatalog.load_default()
    return _default_catalog


def reset_default_catalog() -> None:
    """Force the next ``get_default_catalog`` call to re-read from disk.

    Used by tests and by an admin reload hook (future work).
    """
    global _default_catalog
    _default_catalog = None


# ---------------------------------------------------------------------------
# TRELLIS on-demand fetcher (optional runtime asset source)
# ---------------------------------------------------------------------------
#
# When ``GENESIS_TRELLIS_ENDPOINT`` is set, the catalog can fall back to
# generating an asset on demand instead of requiring a pre-curated GLB.
# The generated mesh is cached locally by a content hash of the request
# parameters so the same query doesn't re-fetch.


def _trellis_cache_dir() -> Path:
    return Path(__file__).resolve().parent / "library" / ".trellis_cache"


def fetch_trellis_asset(
    kind: str,
    dimensions: Sequence[float],
    style_tags: Sequence[str] = (),
    endpoint: Optional[str] = None,
) -> Optional[str]:
    """Fetch a generated GLB from a TRELLIS-compatible HTTP endpoint.

    Falls back to ``GENESIS_TRELLIS_ENDPOINT`` if ``endpoint`` is not
    provided. Returns the local filesystem path to the cached GLB, or
    ``None`` when the endpoint is unconfigured or the request fails.

    The cache key is a SHA-256 of the request JSON so identical queries
    hit the local file on subsequent runs.
    """
    url = (endpoint or os.environ.get("GENESIS_TRELLIS_ENDPOINT", "")).strip()
    if not url:
        return None

    try:
        import hashlib
        import urllib.request

        payload = json.dumps(
            {"kind": kind, "dimensions": list(dimensions), "style_tags": list(style_tags)},
            sort_keys=True,
        ).encode("utf-8")
        key = hashlib.sha256(payload).hexdigest()[:16]
        cache = _trellis_cache_dir()
        cache.mkdir(parents=True, exist_ok=True)
        cached = cache / f"{key}.glb"
        if cached.is_file():
            logger.debug("TRELLIS cache hit: %s (%s)", cached.name, kind)
            return str(cached)

        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json", "Accept": "model/gltf-binary"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            cached.write_bytes(resp.read())
        logger.info("TRELLIS fetched: %s -> %s (%s)", kind, cached.name, url)
        return str(cached)
    except Exception as exc:  # noqa: BLE001
        logger.warning("TRELLIS fetch failed for %s: %s", kind, exc)
        return None
