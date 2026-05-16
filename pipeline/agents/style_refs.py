"""Style-reference analysis agent.

Takes the user's uploaded inspiration images (``intake.style.refs[]`` --
URLs or ``data:`` URIs), runs each one through the VLM
(default Apple FastVLM on-device, or any OpenAI-compatible vision
endpoint) with a tight JSON-only style-extraction prompt, parses the
result into ``StyleCues``, and aggregates across refs into a single
``StyleAnalysis``.

The architect agent then receives the aggregate so its prompt actually
*reflects* what the user uploaded -- right now ``style.refs[]`` only
gets passed as a count. After this, the LLM architect sees concrete
cues like::

    Reference cues from {N} uploaded photo(s):
      archetype: farmhouse
      materials: white shiplap, black metal, oak
      palette:   warm white, charcoal, walnut
      features:  steep gable roof, board-and-batten, deep porch
      mood:      cozy, modern-rustic

This file is best-effort: every failure path returns an empty / partial
``StyleAnalysis`` with explanatory warnings so ``/generate_house``
keeps working when the VLM is unavailable, the network is flaky, or
the model emits malformed JSON.
"""

from __future__ import annotations

import base64
import json
import logging
import re
from collections import Counter
from typing import Iterable, List, Optional, Sequence, Tuple

from ..schemas import StyleAnalysis, StyleCues
from ..vlm import STYLE_ANALYSIS_PROMPT, get_vlm_client


logger = logging.getLogger("genesis.pipeline.style_refs")


# Known architectural archetypes. We normalize the VLM's verbatim
# ``archetype_raw`` to one of these so the architect prompt and the
# editor only have to handle a fixed vocabulary. Aliases live in the
# ARCHETYPE_ALIASES table below.
KNOWN_ARCHETYPES: Tuple[str, ...] = (
    "modern",
    "contemporary",
    "farmhouse",
    "mediterranean",
    "spanish",
    "victorian",
    "barndominium",
    "log-cabin",
    "ranch-house",
    "craftsman",
    "colonial",
    "tudor",
    "mid-century",
    "scandinavian",
    "industrial",
    "minimalist",
)

# Soft mapping from common phrasings the VLM might emit to a canonical
# archetype label. Keys are lowercased substrings.
ARCHETYPE_ALIASES: Tuple[Tuple[str, str], ...] = (
    ("modern farmhouse",   "farmhouse"),
    ("modern-farmhouse",   "farmhouse"),
    ("rustic farmhouse",   "farmhouse"),
    ("country farmhouse",  "farmhouse"),
    ("ranch",              "ranch-house"),
    ("rancher",            "ranch-house"),
    ("ranch style",        "ranch-house"),
    ("log cabin",          "log-cabin"),
    ("logcabin",           "log-cabin"),
    ("a-frame",            "log-cabin"),
    ("barndo",             "barndominium"),
    ("barn dominium",      "barndominium"),
    ("metal barn",         "barndominium"),
    ("mediterranean",      "mediterranean"),
    ("tuscan",             "mediterranean"),
    ("spanish colonial",   "spanish"),
    ("mission",            "spanish"),
    ("mid century",        "mid-century"),
    ("midcentury",         "mid-century"),
    ("mcm",                "mid-century"),
    ("scandi",             "scandinavian"),
    ("scandinavian",       "scandinavian"),
    ("nordic",             "scandinavian"),
    ("japandi",            "scandinavian"),
    ("contemporary modern", "contemporary"),
    ("ultra modern",       "modern"),
    ("modernist",          "modern"),
    ("victorian",          "victorian"),
    ("queen anne",         "victorian"),
    ("craftsman",          "craftsman"),
    ("bungalow",           "craftsman"),
    ("colonial",           "colonial"),
    ("cape cod",           "colonial"),
    ("tudor",              "tudor"),
    ("english cottage",    "tudor"),
)


def normalize_archetype(raw: Optional[str]) -> Optional[str]:
    """Return one of ``KNOWN_ARCHETYPES`` if we can map ``raw`` cleanly."""
    if not raw:
        return None
    s = raw.strip().lower()
    if not s:
        return None
    # Exact match first.
    if s in KNOWN_ARCHETYPES:
        return s
    # Alias substring match.
    for alias, canonical in ARCHETYPE_ALIASES:
        if alias in s:
            return canonical
    # Single-word direct hit (e.g. "spanish" inside "Spanish revival").
    for k in KNOWN_ARCHETYPES:
        if k in s:
            return k
    return None


# ---------------------------------------------------------------------------
# Image fetch
# ---------------------------------------------------------------------------


_DATA_URL_RE = re.compile(r"^data:(?P<mime>[\w/+.\-]+)?;base64,(?P<b64>.+)$", re.DOTALL)
_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def _fetch_image_bytes(ref: str, timeout_s: float = 8.0) -> Tuple[bytes, str]:
    """Return ``(raw_bytes, mime_type)`` for ``ref``.

    Accepts:
      * ``data:image/jpeg;base64,...`` URIs
      * ``http(s)://...`` URLs
      * Local filesystem paths

    Raises on any failure; the caller catches and records a per-ref error.
    """
    # data: URI
    m = _DATA_URL_RE.match(ref.strip())
    if m:
        mime = m.group("mime") or "image/jpeg"
        return base64.b64decode(m.group("b64"), validate=False), mime

    # http(s) URL
    if _URL_RE.match(ref):
        # httpx is already a transitive FastAPI dependency; fall back to
        # urllib if it isn't installed for some odd reason.
        try:
            import httpx  # type: ignore[import-not-found]

            with httpx.Client(timeout=timeout_s, follow_redirects=True) as c:
                r = c.get(ref)
                r.raise_for_status()
                mime = (r.headers.get("content-type") or "image/jpeg").split(";")[0].strip()
                return r.content, mime or "image/jpeg"
        except ImportError:
            from urllib.request import Request, urlopen  # noqa: WPS433
            req = Request(ref, headers={"User-Agent": "genesis-pipeline/0.1"})
            with urlopen(req, timeout=timeout_s) as resp:  # nosec - user-supplied URL
                mime = (resp.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
                return resp.read(), mime or "image/jpeg"

    # Local path fallback.
    with open(ref, "rb") as fh:
        data = fh.read()
    mime = "image/png" if ref.lower().endswith(".png") else "image/jpeg"
    return data, mime


# ---------------------------------------------------------------------------
# Per-image VLM analysis
# ---------------------------------------------------------------------------


def _coerce_json(text: str) -> dict:
    """Pull the first JSON object out of a possibly-noisy VLM response."""
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


def _as_list(v) -> List[str]:
    """Coerce ``v`` into a list of clean string values."""
    if v is None:
        return []
    if isinstance(v, str):
        # The VLM occasionally emits comma-separated strings instead of arrays.
        parts = [p.strip(" .,;:") for p in v.split(",")]
        return [p for p in parts if p]
    if isinstance(v, (list, tuple)):
        out: List[str] = []
        for item in v:
            if isinstance(item, str):
                cleaned = item.strip(" .,;:")
                if cleaned:
                    out.append(cleaned)
            elif item is not None:
                s = str(item).strip(" .,;:")
                if s:
                    out.append(s)
        return out
    s = str(v).strip()
    return [s] if s else []


def _parse_cues_payload(payload: dict, *, image_url: str) -> StyleCues:
    """Map a JSON payload from the VLM into a ``StyleCues`` instance."""
    arch_raw = payload.get("style") or payload.get("archetype")
    if isinstance(arch_raw, list):
        arch_raw = arch_raw[0] if arch_raw else None
    if isinstance(arch_raw, str):
        arch_raw = arch_raw.strip()
    archetype = normalize_archetype(arch_raw if isinstance(arch_raw, str) else None)

    materials = _as_list(payload.get("materials"))
    palette = _as_list(payload.get("colors") or payload.get("palette"))
    features = _as_list(payload.get("features"))

    mood_raw = payload.get("mood")
    if isinstance(mood_raw, list):
        mood = ", ".join(_as_list(mood_raw)) or None
    elif isinstance(mood_raw, str):
        mood = mood_raw.strip() or None
    else:
        mood = None

    conf = payload.get("confidence")
    try:
        confidence = float(conf) if conf is not None else 0.6
    except (TypeError, ValueError):
        confidence = 0.6
    confidence = max(0.0, min(1.0, confidence))

    return StyleCues(
        image_url=image_url,
        archetype=archetype,
        archetype_raw=arch_raw if isinstance(arch_raw, str) else None,
        materials=materials[:8],
        palette=palette[:8],
        features=features[:8],
        mood=mood,
        confidence=confidence,
    )


def _analyze_one(client, ref: str, *, max_tokens: int) -> StyleCues:  # type: ignore[no-untyped-def]
    """Fetch + analyze a single reference; raises on any failure."""
    data, mime = _fetch_image_bytes(ref)
    if not data:
        raise RuntimeError("empty image bytes")
    b64 = base64.b64encode(data).decode("ascii")
    result = client.analyze_image_base64(
        b64,
        STYLE_ANALYSIS_PROMPT,
        mime_type=mime or "image/jpeg",
        max_tokens=max_tokens,
    )
    payload = _coerce_json(result.text)
    return _parse_cues_payload(payload, image_url=ref)


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def _top_n_terms(seqs: Iterable[Sequence[str]], n: int = 6) -> List[str]:
    """Flatten lists from each ref and rank by frequency, ties broken by first appearance."""
    seen_order: dict[str, int] = {}
    counter: Counter[str] = Counter()
    for seq in seqs:
        for term in seq:
            key = term.strip().lower()
            if not key:
                continue
            counter[key] += 1
            seen_order.setdefault(key, len(seen_order))
    if not counter:
        return []
    ranked = sorted(counter.items(), key=lambda kv: (-kv[1], seen_order[kv[0]]))
    return [term for term, _ in ranked[:n]]


def _most_common(values: Iterable[Optional[str]]) -> Optional[str]:
    counter: Counter[str] = Counter()
    for v in values:
        if v:
            counter[v.strip()] += 1
    if not counter:
        return None
    return counter.most_common(1)[0][0]


def _aggregate(refs: Sequence[StyleCues]) -> Tuple[
    Optional[str], List[str], List[str], List[str], Optional[str]
]:
    archetype = _most_common(r.archetype for r in refs if r.archetype)
    materials = _top_n_terms((r.materials for r in refs), n=6)
    palette = _top_n_terms((r.palette for r in refs), n=6)
    features = _top_n_terms((r.features for r in refs), n=6)
    mood = _most_common(r.mood for r in refs if r.mood)
    return archetype, materials, palette, features, mood


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def analyze_style_refs(
    refs: Optional[Sequence[str]],
    *,
    max_refs: int = 4,
    max_tokens: int = 400,
) -> Optional[StyleAnalysis]:
    """Run the VLM over up to ``max_refs`` reference URLs / paths.

    Returns ``None`` when there's nothing to analyze (no refs given) or
    when the VLM backend isn't configured. Always returns ``StyleAnalysis``
    when at least one ref is provided AND a VLM is configured -- even if
    every per-ref call failed (the failures are surfaced as warnings).
    """
    cleaned = [r.strip() for r in (refs or []) if isinstance(r, str) and r.strip()]
    if not cleaned:
        return None

    client = get_vlm_client()
    if client is None:
        # Surface a single warning so the user knows refs were uploaded but
        # not analyzed; still return something so the brief can render the
        # original URLs and explain why nothing was extracted.
        return StyleAnalysis(
            refs=[StyleCues(image_url=u) for u in cleaned[:max_refs]],
            warnings=[
                "No VLM backend configured; reference images were not analyzed. "
                "Set GENESIS_VLM_BACKEND=fastvlm (Apple Silicon) or "
                "GENESIS_VLM_BACKEND=openai with credentials to enable.",
            ],
        )

    targets = cleaned[:max_refs]
    skipped = len(cleaned) - len(targets)
    cues_list: List[StyleCues] = []
    warnings: List[str] = []

    for ref in targets:
        try:
            cues = _analyze_one(client, ref, max_tokens=max_tokens)
        except Exception as exc:  # noqa: BLE001 - record and keep going
            logger.warning("style_refs: analysis failed for %s: %s", ref, exc)
            cues_list.append(StyleCues(
                image_url=ref,
                error=f"{type(exc).__name__}: {exc}",
                confidence=0.0,
            ))
            warnings.append(f"Reference analysis failed: {type(exc).__name__}")
            continue
        cues_list.append(cues)

    archetype, materials, palette, features, mood = _aggregate(
        [c for c in cues_list if c.error is None]
    )

    if skipped > 0:
        warnings.append(
            f"Only analyzed first {max_refs} of {len(cleaned)} reference images "
            f"to keep latency bounded.",
        )

    backend_name: Optional[str] = None
    model_name: Optional[str] = None
    try:
        # Best-effort introspection -- don't crash the response on missing attrs.
        backend_name = getattr(client, "backend_name", None) or type(client).__name__
        if "FastVLM" in backend_name:
            backend_name = "fastvlm"
        elif "OpenAI" in backend_name:
            backend_name = "openai"
        model_name = getattr(client, "model_name", None) or getattr(client, "model", None)
    except Exception:  # pragma: no cover
        pass

    return StyleAnalysis(
        refs=cues_list,
        archetype=archetype,
        materials=materials,
        palette=palette,
        features=features,
        mood=mood,
        backend=backend_name,
        model=model_name,
        warnings=warnings,
    )


def render_cues_for_prompt(analysis: Optional[StyleAnalysis]) -> Optional[str]:
    """Render the analysis as a compact text block for the architect prompt.

    Returns ``None`` if there's nothing useful to inject (no analysis, no
    aggregate cues, or every ref errored out without producing fields).
    """
    if analysis is None:
        return None
    has_aggregate = bool(
        analysis.archetype
        or analysis.materials
        or analysis.palette
        or analysis.features
        or analysis.mood
    )
    if not has_aggregate:
        return None
    successful = [r for r in analysis.refs if r.error is None]

    lines: List[str] = [f"Reference cues from {len(successful)} uploaded photo(s):"]
    if analysis.archetype:
        lines.append(f"  archetype: {analysis.archetype}")
    if analysis.materials:
        lines.append(f"  materials: {', '.join(analysis.materials)}")
    if analysis.palette:
        lines.append(f"  palette:   {', '.join(analysis.palette)}")
    if analysis.features:
        lines.append(f"  features:  {', '.join(analysis.features)}")
    if analysis.mood:
        lines.append(f"  mood:      {analysis.mood}")
    return "\n".join(lines)
