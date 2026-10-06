"""LLM request-timeout helpers.

Central knob for how long a single provider call may hang before the API
returns an actionable error instead of leaving the frontend proxy to die
with an opaque 500/socket hang up.

- ``apply_llm_request_timeout`` sets the httpx-level timeout on a provisioned
  LangChain chat model (field names differ per provider package, so fields
  are probed via ``model_fields`` and missing ones are skipped).
- ``is_llm_timeout_error`` recognises the resulting timeout exceptions at the
  call site so the message can name the budget and the likely cause.

The budget comes from ``OPEN_NOTEBOOK_LLM_TIMEOUT_SECONDS`` (config.py);
0 disables the client-side timeout entirely (previous behaviour).
"""

from __future__ import annotations

from typing import Any, Optional

from loguru import logger

# Attribute names tried in order; first match wins per provider package.
_TIMEOUT_ATTRS = ("request_timeout", "default_request_timeout", "timeout")
_RETRIES_ATTRS = ("max_retries",)


def apply_llm_request_timeout(lc_model: Any, timeout_seconds: Optional[float]) -> None:
    """Cap a chat model's per-request wall time; best-effort across providers.

    Also zeroes provider-side automatic retries when the attribute exists:
    a retry loop multiplied by the timeout is what made hung requests
    effectively unbounded. Models without a recognised timeout field (some
    local/embedded providers) are left untouched with a debug log.
    """
    if not timeout_seconds or timeout_seconds <= 0:
        return
    fields = getattr(type(lc_model), "model_fields", {})
    applied = False
    for attr in _TIMEOUT_ATTRS:
        if attr in fields:
            try:
                setattr(lc_model, attr, timeout_seconds)
                applied = True
            except Exception as e:  # pragma: no cover - defensive
                logger.debug(f"Could not set {attr} on {type(lc_model).__name__}: {e}")
            break
    if not applied:
        logger.debug(
            f"{type(lc_model).__name__} exposes no known timeout attribute; "
            "leaving provider default"
        )
    for attr in _RETRIES_ATTRS:
        if attr in fields:
            try:
                setattr(lc_model, attr, 0)
            except Exception:  # pragma: no cover - defensive
                pass


def is_llm_timeout_error(exc: BaseException) -> bool:
    """True when the exception is an HTTP client / provider request timeout.

    Matches by class name (APITimeoutError, TimeoutException, ...) and by
    the canonical timeout substrings in the message, so the check works even
    when the raising package is not installed in this venv.
    """
    name = type(exc).__name__.lower()
    if "timeout" in name or name == "apitimeouterror":
        return True
    msg = str(exc).lower()
    return "request timed out" in msg or "timed out" in msg


def llm_timeout_message(
    context_tokens: Optional[int], timeout_seconds: float
) -> str:
    """Actionable text for a provider timeout, naming budget and context size.

    Used by the chat graphs: a bare "timed out" reads like a network fault,
    while the real cause is usually an oversized full-content context the
    provider cannot prefill in time. ``context_tokens`` may be None when the
    call site cannot cheaply measure the payload.
    """
    size_part = (
        f" (request context ≈ {context_tokens:,} tokens)"
        if context_tokens
        else ""
    )
    return (
        f"The AI provider did not respond within {timeout_seconds:.0f}s"
        f"{size_part}. Oversized full-content sources are the usual cause: "
        "switch them to 'insights only' in the context panel, exclude them, "
        "or raise OPEN_NOTEBOOK_LLM_TIMEOUT_SECONDS and restart the API."
    )
