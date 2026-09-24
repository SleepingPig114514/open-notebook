from esperanto import LanguageModel
from langchain_core.language_models.chat_models import BaseChatModel
from loguru import logger

from open_notebook.ai.models import model_manager
from open_notebook.ai.thinking import (
    REASONING_LEVELS,
    apply_reasoning_level,
    get_slot_reasoning_level,
)
from open_notebook.exceptions import ConfigurationError
from open_notebook.utils import token_count


async def provision_langchain_model(
    content, model_id, default_type, *, reasoning_level=None, **kwargs
) -> BaseChatModel:
    """
    Returns the best model to use based on the context size and on whether there is a specific model being requested in Config.
    If context > 105_000, returns the large_context_model
    If model_id is specified in Config, returns that model
    Otherwise, returns the default model for the given type

    ``reasoning_level`` is an optional explicit per-request/per-session
    thinking level (off/low/medium/xhigh). When valid it wins over the
    default-slot level; when absent or invalid the slot level applies
    (slot-selected models only), preserving the Settings -> Models semantics.
    """
    tokens = token_count(content)
    model = None
    selection_reason = ""
    slot_type = None

    if tokens > 105_000:
        selection_reason = f"large_context (content has {tokens} tokens)"
        logger.debug(
            f"Using large context model because the content has {tokens} tokens"
        )
        model = await model_manager.get_default_model("large_context", **kwargs)
        slot_type = "large_context"
    elif model_id:
        selection_reason = f"explicit model_id={model_id}"
        model = await model_manager.get_model(model_id, **kwargs)
    else:
        selection_reason = f"default for type={default_type}"
        model = await model_manager.get_default_model(default_type, **kwargs)
        slot_type = default_type

    logger.debug(f"Using model: {model}")

    if model is None:
        logger.error(
            f"Model provisioning failed: No model found. "
            f"Selection reason: {selection_reason}. "
            f"model_id={model_id}, default_type={default_type}. "
            f"Please check Manage → Models and ensure a default model is configured for '{default_type}'."
        )
        raise ConfigurationError(
            f"No model configured for {selection_reason}. "
            f"Please go to Manage → Models and configure a default model for '{default_type}'."
        )

    if not isinstance(model, LanguageModel):
        logger.error(
            f"Model type mismatch: Expected LanguageModel but got {type(model).__name__}. "
            f"Selection reason: {selection_reason}. "
            f"model_id={model_id}, default_type={default_type}."
        )
        raise ConfigurationError(
            f"Model is not a LanguageModel: {model}. "
            f"Please check that the model configured for '{default_type}' is a language model, not an embedding or speech model."
        )

    lc_model = model.to_langchain()

    # Reasoning (thinking) level precedence:
    # 1. explicit per-request/session level (validated defensively),
    # 2. per-slot level from Settings -> Models (slot-selected models only),
    # 3. nothing sent -> provider factory default.
    level = reasoning_level if reasoning_level in REASONING_LEVELS else None
    if level is None and slot_type:
        level = await get_slot_reasoning_level(slot_type)
    if level:
        apply_reasoning_level(lc_model, level)

    return lc_model
