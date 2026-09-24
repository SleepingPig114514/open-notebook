"""Per-slot reasoning (thinking) configuration for language models.

The reasoning level is a *request-level* parameter, not a model property: the
same model can run with different thinking settings in different slots (chat,
transformation, tools, large context). Levels are stored in the
``DefaultModels.model_args`` record keyed by the slot's model field name, and
merged into the ChatOpenAI request payload via ``extra_body`` at provisioning
time.

Level -> DashScope/OpenAI-compatible parameter mapping:

- ``off``                -> ``{"enable_thinking": false}``
- ``low/medium/xhigh``   -> ``{"enable_thinking": true, "reasoning_effort": <level>}``
- ``default`` / missing  -> nothing is sent (provider factory default)

``reasoning_effort`` and ``thinking_budget`` must not be sent together; this
module only ever emits ``reasoning_effort``.
"""

from typing import Any, Dict, Optional

from loguru import logger

# Levels accepted by qwen3.7/3.8 hybrid-thinking models (plus "off").
REASONING_LEVELS = frozenset({"off", "low", "medium", "xhigh"})


def build_reasoning_extra_body(level: Optional[str]) -> Optional[Dict[str, Any]]:
    """Translate a stored level into the extra_body dict to merge into requests.

    Returns None when no override should be sent (unset/invalid/"default").
    """
    if not level or level not in REASONING_LEVELS:
        return None
    if level == "off":
        return {"enable_thinking": False}
    return {"enable_thinking": True, "reasoning_effort": level}


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
