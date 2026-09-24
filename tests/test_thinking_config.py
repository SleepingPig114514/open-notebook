"""Unit tests for the per-slot reasoning (thinking) configuration."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from open_notebook.ai.thinking import (
    REASONING_LEVELS,
    apply_reasoning_level,
    build_reasoning_extra_body,
    get_slot_reasoning_level,
)


class TestBuildReasoningExtraBody:
    def test_off_disables_thinking(self):
        assert build_reasoning_extra_body("off") == {"enable_thinking": False}

    def test_levels_map_to_reasoning_effort(self):
        for level in REASONING_LEVELS - {"off"}:
            assert build_reasoning_extra_body(level) == {
                "enable_thinking": True,
                "reasoning_effort": level,
            }

    def test_unset_or_invalid_sends_nothing(self):
        assert build_reasoning_extra_body(None) is None
        assert build_reasoning_extra_body("") is None
        assert build_reasoning_extra_body("default") is None
        assert build_reasoning_extra_body("ultra") is None


class TestApplyReasoningLevel:
    def test_merges_into_extra_body(self):
        model = MagicMock(spec=["extra_body"])
        type(model).model_fields = {"extra_body": None}
        model.extra_body = {"existing": 1}
        apply_reasoning_level(model, "low")
        assert model.extra_body == {
            "existing": 1,
            "enable_thinking": True,
            "reasoning_effort": "low",
        }

    def test_noop_without_level(self):
        model = MagicMock(spec=["extra_body"])
        type(model).model_fields = {"extra_body": None}
        model.extra_body = {"existing": 1}
        apply_reasoning_level(model, None)
        assert model.extra_body == {"existing": 1}

    def test_skips_models_without_extra_body_field(self):
        model = MagicMock(spec=[])
        apply_reasoning_level(model, "off")  # no exception, no attribute set
        assert not hasattr(model, "extra_body")

    def test_real_chat_openai_accepts_extra_body(self):
        from langchain_openai import ChatOpenAI
        from pydantic import SecretStr

        model = ChatOpenAI(model="qwen3.8-flash", api_key=SecretStr("not-a-real-key"))
        apply_reasoning_level(model, "off")
        assert model.extra_body == {"enable_thinking": False}


class TestGetSlotReasoningLevel:
    def _defaults(self, model_args, chat_set=True):
        defaults = MagicMock()
        defaults.model_args = model_args
        defaults.default_chat_model = "model:chat" if chat_set else None
        defaults.default_transformation_model = None
        defaults.default_tools_model = None
        defaults.large_context_model = None
        return defaults

    @pytest.mark.asyncio
    async def test_reads_stored_level(self):
        d = self._defaults({"default_chat_model": "off"})
        with patch(
            "open_notebook.ai.models.DefaultModels.get_instance",
            new=AsyncMock(return_value=d),
        ):
            assert await get_slot_reasoning_level("chat") == "off"

    @pytest.mark.asyncio
    async def test_empty_slot_falls_back_to_chat_level(self):
        # transformation slot has no model -> chat model is used -> chat level applies
        d = self._defaults({"default_chat_model": "low"})
        with patch(
            "open_notebook.ai.models.DefaultModels.get_instance",
            new=AsyncMock(return_value=d),
        ):
            assert await get_slot_reasoning_level("transformation") == "low"

    @pytest.mark.asyncio
    async def test_assigned_slot_without_level_is_none(self):
        d = self._defaults({"default_chat_model": "low"})
        d.default_transformation_model = "model:transform"
        with patch(
            "open_notebook.ai.models.DefaultModels.get_instance",
            new=AsyncMock(return_value=d),
        ):
            assert await get_slot_reasoning_level("transformation") is None

    @pytest.mark.asyncio
    async def test_invalid_level_ignored(self):
        d = self._defaults({"default_chat_model": "ultra"})
        with patch(
            "open_notebook.ai.models.DefaultModels.get_instance",
            new=AsyncMock(return_value=d),
        ):
            assert await get_slot_reasoning_level("chat") is None

    @pytest.mark.asyncio
    async def test_non_language_type_is_none(self):
        assert await get_slot_reasoning_level("embedding") is None


class TestProvisionExplicitLevel:
    """Batch 2: explicit per-request/session level beats the slot level."""

    def _lc(self):
        from langchain_openai import ChatOpenAI
        from pydantic import SecretStr

        return ChatOpenAI(model="test-model", api_key=SecretStr("not-a-real-key"))

    @pytest.mark.asyncio
    async def _provision(self, model_id, reasoning_level, slot_level, lc_model):
        from unittest.mock import AsyncMock, MagicMock, patch

        from open_notebook.ai.models import LanguageModel
        from open_notebook.ai.provision import provision_langchain_model

        esperanto_model = MagicMock(spec=LanguageModel)
        esperanto_model.to_langchain.return_value = lc_model

        getter = AsyncMock(return_value=esperanto_model)
        with patch("open_notebook.ai.provision.model_manager.get_model", getter), \
             patch(
                 "open_notebook.ai.provision.get_slot_reasoning_level",
                 AsyncMock(return_value=slot_level),
             ):
            result = await provision_langchain_model(
                "hello", model_id, "chat", reasoning_level=reasoning_level
            )
        return result

    @pytest.mark.asyncio
    async def test_explicit_level_applied(self):
        lc = self._lc()
        result = await self._provision(None, "off", "medium", lc)
        assert result is lc
        # explicit level wins over the slot level
        assert lc.extra_body == {"enable_thinking": False}

    @pytest.mark.asyncio
    async def test_invalid_explicit_falls_back_to_slot(self):
        lc = self._lc()
        result = await self._provision(None, "banana", "low", lc)
        assert lc.extra_body == {"enable_thinking": True, "reasoning_effort": "low"}
        assert result is lc

    @pytest.mark.asyncio
    async def test_explicit_model_id_without_level_sends_nothing(self):
        # temporary hand-picked model: no slot semantics apply, nothing injected
        lc = self._lc()
        await self._provision("model:picked", None, "medium", lc)
        assert not getattr(lc, "extra_body", None)


class TestAskReasoningLevelsHelper:
    def _req(self, **kwargs):
        from api.models import AskRequest

        base = dict(
            question="q",
            strategy_model="model:s",
            answer_model="model:a",
            final_answer_model="model:f",
        )
        base.update(kwargs)
        return AskRequest(**base)

    def test_only_non_none_collected(self):
        from api.routers.search import _ask_reasoning_levels

        req = self._req(strategy_reasoning_level="off", answer_reasoning_level=None)
        assert _ask_reasoning_levels(req) == {"strategy_reasoning_level": "off"}

    def test_all_none_is_empty(self):
        from api.routers.search import _ask_reasoning_levels

        assert _ask_reasoning_levels(self._req()) == {}

    def test_invalid_level_rejected(self):
        import pydantic

        with pytest.raises(pydantic.ValidationError):
            self._req(final_answer_reasoning_level="turbo")


class TestTransformationReasoningValidation:
    def test_create_accepts_valid_level(self):
        from api.models import TransformationCreate

        t = TransformationCreate(
            name="n", title="T", description="d", prompt="p",
            apply_default=False, reasoning_level="xhigh",
        )
        assert t.reasoning_level == "xhigh"

    def test_create_rejects_invalid_level(self):
        import pydantic

        from api.models import TransformationCreate

        with pytest.raises(pydantic.ValidationError):
            TransformationCreate(
                name="n", title="T", description="d", prompt="p",
                apply_default=False, reasoning_level="ultra",
            )

    def test_execute_request_has_level_field(self):
        from api.models import TransformationExecuteRequest

        fields = TransformationExecuteRequest.model_fields
        assert "reasoning_level" in fields
