"""Vision Language Model (VLM) integration for Genesis pipeline.

Supports two VLM backends:

1. **Apple FastVLM** — on-device via MLX (Apple Silicon). Zero-latency,
   private, runs without internet. Best for: analyzing reference photos,
   style interpretation, floor plan critique.

2. **Custom VLM** — any OpenAI-compatible vision endpoint (GPT-4o,
   LLaVA, Qwen-VL, etc.) via the same client infrastructure as the
   architect agent.

Usage in the pipeline:

    from pipeline.vlm.client import get_vlm_client
    
    vlm = get_vlm_client()
    result = vlm.analyze_image(
        image_path="/path/to/reference.jpg",
        prompt="Describe the architectural style and key design elements.",
    )
    print(result.text)

Environment variables:

    GENESIS_VLM_BACKEND=fastvlm      # or "openai" for cloud VLM
    GENESIS_VLM_MODEL=FastVLM-0.5B   # FastVLM model size (0.5B, 1.5B, 7B)
    GENESIS_VLM_BASE_URL=            # for openai backend
    GENESIS_VLM_API_KEY=             # for openai backend
"""

from __future__ import annotations

import base64
import logging
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger("genesis.pipeline.vlm")


@dataclass(frozen=True)
class VLMResult:
    text: str
    model: str
    backend: str
    tokens_used: Optional[int] = None


class VLMClient(ABC):
    """Abstract VLM client."""

    @abstractmethod
    def analyze_image(
        self,
        image_path: str | Path,
        prompt: str,
        max_tokens: int = 500,
    ) -> VLMResult:
        ...

    @abstractmethod
    def analyze_image_base64(
        self,
        image_b64: str,
        prompt: str,
        mime_type: str = "image/jpeg",
        max_tokens: int = 500,
    ) -> VLMResult:
        ...


# ---------------------------------------------------------------------------
# Apple FastVLM (on-device, MLX)
# ---------------------------------------------------------------------------


class FastVLMClient(VLMClient):
    """Runs Apple's FastVLM locally via MLX on Apple Silicon.

    Requires:
        pip install mlx mlx-vlm
        # Model weights are downloaded automatically on first use.
    """

    def __init__(self, model_name: str = "FastVLM-0.5B") -> None:
        self.model_name = model_name
        self._model = None
        self._processor = None
        self._loaded = False

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        try:
            from mlx_vlm import load, generate
            self._generate_fn = generate
            logger.info("Loading FastVLM model: %s", self.model_name)
            self._model, self._processor = load(
                f"apple/{self.model_name}",
                trust_remote_code=True,
            )
            self._loaded = True
            logger.info("FastVLM model loaded successfully")
        except ImportError as exc:
            raise RuntimeError(
                "FastVLM requires mlx and mlx-vlm. Install with: "
                "pip install mlx mlx-vlm"
            ) from exc

    def analyze_image(
        self,
        image_path: str | Path,
        prompt: str,
        max_tokens: int = 500,
    ) -> VLMResult:
        self._ensure_loaded()
        from mlx_vlm import generate

        result = generate(
            self._model,
            self._processor,
            str(image_path),
            prompt,
            max_tokens=max_tokens,
        )
        return VLMResult(
            text=result,
            model=self.model_name,
            backend="fastvlm",
        )

    def analyze_image_base64(
        self,
        image_b64: str,
        prompt: str,
        mime_type: str = "image/jpeg",
        max_tokens: int = 500,
    ) -> VLMResult:
        import tempfile

        # FastVLM works with file paths; write base64 to temp file
        suffix = ".jpg" if "jpeg" in mime_type else ".png"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(base64.b64decode(image_b64))
            tmp_path = f.name
        try:
            return self.analyze_image(tmp_path, prompt, max_tokens)
        finally:
            os.unlink(tmp_path)


# ---------------------------------------------------------------------------
# OpenAI-compatible VLM (GPT-4o, LLaVA, Qwen-VL, etc.)
# ---------------------------------------------------------------------------


class OpenAIVLMClient(VLMClient):
    """Uses any OpenAI-compatible vision endpoint."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        model: str = "gpt-4o",
    ) -> None:
        from openai import OpenAI

        self.model = model
        self._client = OpenAI(
            base_url=base_url,
            api_key=api_key or os.environ.get("GENESIS_VLM_API_KEY") or os.environ.get("OPENAI_API_KEY"),
        )

    def analyze_image(
        self,
        image_path: str | Path,
        prompt: str,
        max_tokens: int = 500,
    ) -> VLMResult:
        path = Path(image_path)
        mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
        b64 = base64.b64encode(path.read_bytes()).decode()
        return self.analyze_image_base64(b64, prompt, mime, max_tokens)

    def analyze_image_base64(
        self,
        image_b64: str,
        prompt: str,
        mime_type: str = "image/jpeg",
        max_tokens: int = 500,
    ) -> VLMResult:
        resp = self._client.chat.completions.create(
            model=self.model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{mime_type};base64,{image_b64}",
                            },
                        },
                    ],
                }
            ],
            max_tokens=max_tokens,
        )
        text = resp.choices[0].message.content or ""
        tokens = resp.usage.total_tokens if resp.usage else None
        return VLMResult(
            text=text,
            model=self.model,
            backend="openai",
            tokens_used=tokens,
        )


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

_vlm_client: Optional[VLMClient] = None


def get_vlm_client() -> Optional[VLMClient]:
    """Return a cached VLM client based on environment config.

    Returns None if no VLM backend is configured.
    """
    global _vlm_client
    if _vlm_client is not None:
        return _vlm_client

    backend = os.environ.get("GENESIS_VLM_BACKEND", "").lower()

    if backend == "fastvlm":
        model = os.environ.get("GENESIS_VLM_MODEL", "FastVLM-0.5B")
        try:
            _vlm_client = FastVLMClient(model_name=model)
            logger.info("VLM: FastVLM backend enabled (model=%s)", model)
            return _vlm_client
        except Exception as exc:
            logger.warning("FastVLM init failed: %s", exc)
            return None

    if backend == "openai":
        base_url = os.environ.get("GENESIS_VLM_BASE_URL")
        api_key = os.environ.get("GENESIS_VLM_API_KEY") or os.environ.get("OPENAI_API_KEY")
        model = os.environ.get("GENESIS_VLM_MODEL", "gpt-4o")
        if not api_key and not base_url:
            logger.info("VLM: OpenAI backend selected but no API key configured")
            return None
        try:
            _vlm_client = OpenAIVLMClient(base_url=base_url, api_key=api_key, model=model)
            logger.info("VLM: OpenAI backend enabled (model=%s)", model)
            return _vlm_client
        except Exception as exc:
            logger.warning("OpenAI VLM init failed: %s", exc)
            return None

    # Not configured
    return None


# ---------------------------------------------------------------------------
# High-level helpers for the pipeline
# ---------------------------------------------------------------------------


STYLE_ANALYSIS_PROMPT = """Analyze this architectural reference image and describe:

1. **Style**: What architectural style is this? (modern, farmhouse, mediterranean, spanish, victorian, barndominium, log-cabin, ranch-house, contemporary)
2. **Materials**: What materials are prominent? (wood, stone, stucco, metal, glass, brick)
3. **Colors**: What is the dominant color palette?
4. **Features**: Key architectural features (roof type, window style, porch, columns, etc.)
5. **Mood**: What feeling does this design evoke?

Return a JSON object with keys: style, materials, colors, features, mood.
Each should be a string or list of strings."""


FLOORPLAN_CRITIQUE_PROMPT = """You are an expert residential architect reviewing a floor plan.

Analyze this floor plan image and provide:

1. **Flow**: How well do the spaces connect? Is there a logical flow from entry to living to private areas?
2. **Issues**: Any code compliance concerns, awkward transitions, or wasted space?
3. **Suggestions**: 2-3 specific improvements that would make this plan better.
4. **Rating**: Score the plan 1-10 for livability.

Return a JSON object with keys: flow, issues, suggestions, rating."""


# ---------------------------------------------------------------------------
# Hero-render critique
# ---------------------------------------------------------------------------
# Used by ``pipeline/agents/render_critique.py``. The agent fills the
# ``{view_label}`` placeholder so the VLM knows whether it's looking at
# an exterior front shot, an aerial, or an interior. The model is
# explicitly told to return ONLY a JSON object so we can parse with the
# same forgiving extractor the style-refs agent uses.

RENDER_CRITIQUE_PROMPT_TEMPLATE = """You are a senior residential architect reviewing a photoreal Cycles render of an AI-generated home.

This image is the {view_label} of the home.

Critique it from a designer-architect's perspective. Focus on:
  * massing and proportions (does it feel like a real home?)
  * material cohesion (do the surfaces, palette, and finishes work together?)
  * scale and human factors (door height, ceiling height, furniture sizing)
  * lighting and atmosphere (does the render read as a real space?)
  * obvious pipeline tells (clipping, missing details, placeholder geometry)

Return ONE JSON object with EXACTLY these keys (no prose, no markdown fences):

{{
  "strengths":   ["<short positive observation>", ...],   // 1 to 3 items
  "issues":      ["<short specific problem>", ...],        // 1 to 3 items
  "suggestions": ["<short actionable change>", ...],       // 1 to 2 items
  "score":       <number 1.0 to 10.0>,                     // overall quality
  "summary":     "<one-line verdict, max 80 characters>"
}}
"""


# Human-readable labels for each known hero-render view. Kept here (not
# in the agent file) so the same labels can drive both the VLM prompt
# and the front-end critique panel.
RENDER_VIEW_LABELS = {
    "exterior_front":  "front-facing exterior, looking at the entry from across the front yard",
    "exterior_aerial": "aerial 45-degree view of the entire home from a corner of the lot",
    "interior_living": "wide-angle interior of the living room",
    "interior_master": "wide-angle interior of the master bedroom suite",
}


def render_critique_prompt(view: str) -> str:
    """Render the critique prompt for a specific view."""
    label = RENDER_VIEW_LABELS.get(view, view.replace("_", " "))
    return RENDER_CRITIQUE_PROMPT_TEMPLATE.format(view_label=label)


def analyze_reference_image(image_path: str | Path) -> Optional[VLMResult]:
    """Analyze a reference image for architectural style cues."""
    client = get_vlm_client()
    if client is None:
        return None
    try:
        return client.analyze_image(image_path, STYLE_ANALYSIS_PROMPT)
    except Exception as exc:
        logger.warning("VLM style analysis failed: %s", exc)
        return None


def critique_floorplan(image_path: str | Path) -> Optional[VLMResult]:
    """Get an expert critique of a floor plan image."""
    client = get_vlm_client()
    if client is None:
        return None
    try:
        return client.analyze_image(image_path, FLOORPLAN_CRITIQUE_PROMPT)
    except Exception as exc:
        logger.warning("VLM floorplan critique failed: %s", exc)
        return None
