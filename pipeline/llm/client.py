"""LLM client for the Genesis pipeline.

Uses the OpenAI Python SDK against any OpenAI-compatible endpoint, so the
same client code works against:

  * OpenRouter        (https://openrouter.ai/api/v1)              -- recommended for dev
  * Together          (https://api.together.xyz/v1)
  * Fireworks         (https://api.fireworks.ai/inference/v1)
  * Groq              (https://api.groq.com/openai/v1)
  * vLLM / TGI        (http://your-host:8000/v1)                  -- recommended for prod on A100
  * Ollama / LM Studio (http://localhost:11434/v1)
  * OpenAI            (default; if you must)

Default model is **Qwen 2.5 72B Instruct** -- Apache 2.0 licensed, currently
the strongest open-weights model for structured-output / instruction-
following tasks at the 70B scale, which is exactly what an architect
agent needs (interpret a vibe + program, emit a JSON room list).
Acceptable substitutes:

  * meta-llama/Llama-3.3-70B-Instruct        (Llama license, similar quality)
  * deepseek-ai/DeepSeek-V3                  (671B MoE, MIT, top-tier reasoning)
  * Qwen/Qwen2.5-32B-Instruct                (fits 1xA100 4-bit, fast)

The client is intentionally small: it owns env wiring, retries, and a
JSON-parsing helper that validates against a Pydantic model so the rest
of the pipeline can treat agent outputs as plain typed objects.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Optional, Type, TypeVar

from pydantic import BaseModel, ValidationError

try:
    from openai import OpenAI
    from openai import APIError, APIConnectionError, RateLimitError
except Exception:  # pragma: no cover - openai is an optional runtime dep
    OpenAI = None  # type: ignore[assignment]
    APIError = APIConnectionError = RateLimitError = Exception  # type: ignore[assignment]


logger = logging.getLogger("genesis.pipeline.llm")


# Model that gets picked when GENESIS_LLM_MODEL isn't set.  Chosen because
# it is open-weights (Apache 2.0), strong at structured JSON output, and
# served by every major OpenAI-compatible provider under this slug.
DEFAULT_MODEL = "qwen/qwen-2.5-72b-instruct"


T = TypeVar("T", bound=BaseModel)


@dataclass(frozen=True)
class LLMConfig:
    base_url: Optional[str]
    api_key: Optional[str]
    model: str
    temperature: float
    max_tokens: int
    request_timeout: float
    max_retries: int

    @property
    def configured(self) -> bool:
        # OpenAI-compatible local servers (vLLM, Ollama) often don't need a
        # real key, just any non-empty placeholder. So we treat "has a base
        # url" as configured even without a key, as long as openai is
        # installed.
        return OpenAI is not None and (bool(self.api_key) or bool(self.base_url))

    @property
    def display_endpoint(self) -> str:
        return self.base_url or "https://api.openai.com/v1"


def load_config() -> LLMConfig:
    base_url = os.environ.get("GENESIS_LLM_BASE_URL") or os.environ.get("OPENAI_BASE_URL") or None
    api_key = (
        os.environ.get("GENESIS_LLM_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or None
    )
    model = (
        os.environ.get("GENESIS_ARCHITECT_MODEL")
        or os.environ.get("GENESIS_LLM_MODEL")
        or DEFAULT_MODEL
    )
    return LLMConfig(
        base_url=base_url.rstrip("/") if base_url else None,
        # Some local servers require *some* string. Use a placeholder if
        # none was provided but a base url exists.
        api_key=api_key or ("local-no-key" if base_url else None),
        model=model,
        temperature=float(os.environ.get("GENESIS_LLM_TEMPERATURE", "0.4")),
        max_tokens=int(os.environ.get("GENESIS_LLM_MAX_TOKENS", "2000")),
        request_timeout=float(os.environ.get("GENESIS_LLM_TIMEOUT", "45")),
        max_retries=int(os.environ.get("GENESIS_LLM_RETRIES", "2")),
    )


class LLMUnavailable(RuntimeError):
    """Raised when no LLM is configured or the SDK isn't installed."""


class LLMClient:
    """Thin wrapper around the OpenAI SDK with JSON-parsing helpers."""

    def __init__(self, config: Optional[LLMConfig] = None) -> None:
        self.config = config or load_config()
        if not self.config.configured:
            raise LLMUnavailable(
                "LLM is not configured. Set GENESIS_LLM_BASE_URL + GENESIS_LLM_API_KEY "
                "(or OPENAI_API_KEY) to enable the LLM architect agent."
            )
        if OpenAI is None:
            raise LLMUnavailable("openai SDK is not installed; pip install openai")
        self._client = OpenAI(
            base_url=self.config.base_url,
            api_key=self.config.api_key,
            timeout=self.config.request_timeout,
        )

    @property
    def model(self) -> str:
        return self.config.model

    def chat_json(
        self,
        *,
        system: str,
        user: str,
        schema: Type[T],
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
    ) -> T:
        """Run a chat completion that must return JSON validating against ``schema``.

        Tries native ``response_format={"type":"json_object"}`` first, with
        retries and a permissive JSON-extraction fallback for providers that
        don't fully honor the flag.
        """

        last_err: Optional[BaseException] = None
        for attempt in range(self.config.max_retries + 1):
            try:
                resp = self._client.chat.completions.create(
                    model=self.config.model,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    temperature=temperature if temperature is not None else self.config.temperature,
                    max_tokens=max_tokens or self.config.max_tokens,
                    response_format={"type": "json_object"},
                )
                content = resp.choices[0].message.content or ""
                payload = _coerce_json(content)
                return schema.model_validate(payload)
            except (APIError, APIConnectionError, RateLimitError) as exc:
                last_err = exc
                wait = 0.6 * (2 ** attempt)
                logger.warning(
                    "LLM call failed (attempt %d/%d) on %s: %s; retrying in %.1fs",
                    attempt + 1,
                    self.config.max_retries + 1,
                    self.config.display_endpoint,
                    exc,
                    wait,
                )
                time.sleep(wait)
            except (ValidationError, ValueError) as exc:
                # Bad JSON from the model -- retry with a stricter nudge.
                last_err = exc
                logger.warning(
                    "LLM returned invalid JSON (attempt %d/%d): %s",
                    attempt + 1,
                    self.config.max_retries + 1,
                    exc,
                )
                # Append a strict-JSON nudge for the retry by appending to
                # the user message on subsequent passes.
                user = (
                    user
                    + "\n\nIMPORTANT: Return ONLY a single JSON object that "
                    "matches the schema. No prose, no code fences."
                )
        assert last_err is not None
        raise last_err


def _coerce_json(text: str) -> dict:
    """Extract the first JSON object from a response. Some providers wrap
    JSON in markdown fences even when asked not to."""
    text = (text or "").strip()
    if not text:
        raise ValueError("Empty LLM response")
    # Try direct parse first.
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Strip ```json ... ``` fences.
    if text.startswith("```"):
        # remove first fence line and trailing ```
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        try:
            return json.loads("\n".join(lines))
        except json.JSONDecodeError:
            pass
    # Last-ditch: locate the outermost { ... } span.
    start = text.find("{")
    end = text.rfind("}")
    if 0 <= start < end:
        candidate = text[start : end + 1]
        return json.loads(candidate)
    raise ValueError("LLM response did not contain JSON")


_default_client: Optional[LLMClient] = None
_default_client_failed: bool = False


def get_default_client() -> Optional[LLMClient]:
    """Return a process-wide cached client, or ``None`` if not configured."""

    global _default_client, _default_client_failed
    if _default_client is not None:
        return _default_client
    if _default_client_failed:
        return None
    try:
        _default_client = LLMClient()
        logger.info(
            "LLM architect enabled: model=%s endpoint=%s",
            _default_client.config.model,
            _default_client.config.display_endpoint,
        )
        return _default_client
    except LLMUnavailable as exc:
        _default_client_failed = True
        logger.info("LLM architect disabled: %s", exc)
        return None
