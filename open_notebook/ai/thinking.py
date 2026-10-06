"""Per-slot reasoning (thinking) configuration for language models.

The reasoning level is a *request-level* parameter, not a model property: the
same model can run with different thinking settings in different slots (chat,
transformation, tools, large context). Levels are stored in the
``DefaultModels.model_args`` record keyed by the slot's model field name, and
merged into the ChatOpenAI request payload via ``extra_body`` at provisioning
time.

Level -> DashScope/OpenAI-compatible parameter mapping:

- ``off``                -> ``{"enable_thinking": false}``
- ``low/medium/xhigh``   -> ``{"enable_thinking": true, "thinking_budget": <tokens>}``
- ``default`` / missing  -> nothing is sent (provider factory default)

Why ``thinking_budget`` and not ``reasoning_effort``: on the qwen3.x
endpoints the server expands ``reasoning_effort`` into an internal thinking
budget (medium -> 16k/32k depending on model) while our graphs hard-code
``max_tokens=8192``. DashScope rejects any request where
``max_completion_tokens <= thinking_budget`` with a 400
(invalid_parameter_error). Sending an explicit budget keeps the two numbers
in our control; ``apply_reasoning_level`` then raises the model instance's
max_tokens above the budget when needed. ``reasoning_effort`` and
``thinking_budget`` must never be sent together.
"""

from typing import Any, Dict, Optional

from loguru import logger

# Levels accepted by qwen3.7/3.8 hybrid-thinking models (plus "off").
REASONING_LEVELS = frozenset({"off", "low", "medium", "xhigh"})

# Explicit per-level thinking budgets. Chosen so each value lands inside the
# DashScope reverse-mapping bands (0-4096 low, 4097-16384 medium,
# 16385-262144 xhigh) and stays below hard-coded graph max_tokens after the
# bump below. xhigh is capped at 24576 (server default would exceed what
# flash-class models can answer within).
REASONING_BUDGETS: Dict[str, int] = {"low": 4096, "medium": 12288, "xhigh": 24576}

# Token room kept for the answer when max_tokens must grow past a budget.
ANSWER_SLACK_TOKENS = 4096


def build_reasoning_extra_body(level: Optional[str]) -> Optional[Dict[str, Any]]:
    """Translate a stored level into the extra_body dict to merge into requests.

    Returns None when no override should be sent (unset/invalid/"default").
    """
    if not level or level not in REASONING_LEVELS:
        return None
    if level == "off":
        return {"enable_thinking": False}
    return {"enable_thinking": True, "thinking_budget": REASONING_BUDGETS[level]}


# DefaultModels field for each provisionable slot type.
SLOT_FIELDS: Dict[str, str] = {
    "chat": "default_chat_model",
    "transformation": "default_transformation_model",
    "tools": "default_tools_model",
    "large_context": "large_context_model",
}


async def get_slot_reasoning_level(default_type: str) -> Optional[str]:
    """Read the stored reasoning level for a default-model slot type.

    Mirrors the model-fallback semantics of ``get_default_model``: an empty
    transformation/tools/large-context slot falls back to the chat slot's
    level, because the chat model is the one actually used. Any lookup
    failure degrades to None (factory default) rather than breaking model
    provisioning.
    """
    from open_notebook.ai.models import DefaultModels

    slot = SLOT_FIELDS.get(default_type)
    if not slot:
        return None
    try:
        defaults = await DefaultModels.get_instance()
    except Exception as e:  # pragma: no cover - defensive: DB hiccup
        logger.debug(f"Could not load reasoning-level config: {e}")
        return None
    args: Dict[str, Any] = getattr(defaults, "model_args", None) or {}
    level = args.get(slot)
    if not (isinstance(level, str) and level in REASONING_LEVELS):
        # Empty slot -> chat model is used -> chat slot's level applies.
        if not getattr(defaults, slot, None):
            level = args.get(SLOT_FIELDS["chat"])
        else:
            return None
    return level if isinstance(level, str) and level in REASONING_LEVELS else None


def apply_reasoning_level(lc_model: Any, level: Optional[str]) -> None:
    """Merge the level's extra_body into a LangChain chat model instance.

    Only ChatOpenAI-style models expose ``extra_body``; other providers
    (anthropic, gemini, ...) are left untouched with a debug log.

    When a thinking budget is injected, the instance's output cap is raised
    above it if necessary: DashScope rejects requests where
    ``max_completion_tokens <= thinking_budget`` (graphs hard-code 8192),
    so budgets of 12288/24576 would otherwise 400 on medium/xhigh.
    """
    extra = build_reasoning_extra_body(level)
    if not extra:
        return
    if "extra_body" not in getattr(type(lc_model), "model_fields", {}):
        logger.debug(
            f"Model {type(lc_model).__name__} has no extra_body field; "
            f"ignoring reasoning level {level!r}"
        )
        return
    merged = dict(getattr(lc_model, "extra_body", None) or {})
    merged.update(extra)
    lc_model.extra_body = merged

    budget = extra.get("thinking_budget")
    if not isinstance(budget, int):
        return
    fields = getattr(type(lc_model), "model_fields", {})
    # langchain_openai honours whichever of the two aliases is set; bump both
    # present ones so the wire parameter (max_completion_tokens) always
    # exceeds the budget we just injected.
    for attr in ("max_completion_tokens", "max_tokens"):
        if attr not in fields:
            continue
        current = getattr(lc_model, attr, None)
        if isinstance(current, int) and current <= budget:
            setattr(lc_model, attr, budget + ANSWER_SLACK_TOKENS)
            logger.debug(
                f"Raised {attr} {current} -> {budget + ANSWER_SLACK_TOKENS} "
                f"to fit thinking_budget {budget} (level {level!r})"
            )
