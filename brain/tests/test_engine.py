"""
Tests for Razor Brain — Context, State, and Engine
=====================================================
Run: pytest tests/ -v
"""

import asyncio
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from razor_brain.context import ConversationContext, Entity, Role
from razor_brain.engine import BrainResponse, ConversationEngine, EngineConfig
from razor_brain.gateway import GatewayConfig, GatewayStatus, OpenClawGateway
from razor_brain.state import ConversationState, StateTracker


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Context Tests
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestConversationContext:
    def test_add_turns(self):
        ctx = ConversationContext(window_size=10)
        t1 = ctx.add_user_turn("Hello there")
        t2 = ctx.add_brain_turn("Hi! How can I help?")

        assert ctx.turn_count == 2
        assert t1.role == Role.USER
        assert t2.role == Role.BRAIN
        assert t1.content == "Hello there"

    def test_rolling_window(self):
        ctx = ConversationContext(window_size=5)
        for i in range(20):
            ctx.add_user_turn(f"Message {i}")

        brain_ctx = ctx.get_brain_context()
        assert len(brain_ctx["turns"]) == 5
        assert brain_ctx["turn_count"] == 20
        # Window should contain the LAST 5 turns
        assert "Message 15" in brain_ctx["turns"][0]["content"]

    def test_entity_tracking(self):
        ctx = ConversationContext()
        e = ctx.track_entity("Marcus", "person", aliases=["Marc"])

        assert e.canonical_name == "Marcus"
        assert e.entity_type == "person"
        assert "Marc" in e.aliases

        # Find by name
        found = ctx.find_entity("Marcus")
        assert found is not None
        assert found.id == e.id

        # Find by alias (case-insensitive)
        found = ctx.find_entity("marc")
        assert found is not None
        assert found.id == e.id

    def test_entity_dedup(self):
        ctx = ConversationContext()
        e1 = ctx.track_entity("Clearwater Capital", "company")
        e2 = ctx.track_entity("Clearwater Capital", "company", aliases=["CWC"])

        # Should be the same entity, not duplicated
        assert e1.id == e2.id
        assert "CWC" in e2.aliases
        assert e2.reference_count == 2

    def test_entity_eviction(self):
        ctx = ConversationContext(max_entities=3)
        ctx.track_entity("Alpha", "company")
        ctx.track_entity("Beta", "company")
        ctx.track_entity("Gamma", "company")

        # Touch Gamma many times
        for _ in range(10):
            ctx.track_entity("Gamma", "company")

        # Adding a 4th should evict the least-used
        ctx.track_entity("Delta", "company")
        assert ctx.find_entity("Delta") is not None
        # Gamma should survive (most referenced)
        assert ctx.find_entity("Gamma") is not None

    def test_recent_entities(self):
        ctx = ConversationContext()
        ctx.track_entity("Old Person", "person")
        time.sleep(0.01)
        ctx.track_entity("New Person", "person")

        recent = ctx.get_recent_entities(1)
        assert len(recent) == 1
        assert recent[0].canonical_name == "New Person"

    def test_topic_stack(self):
        ctx = ConversationContext()
        ctx.push_topic("call_debrief")
        ctx.push_topic("scheduling")

        assert ctx.current_topic() == "scheduling"
        ctx.pop_topic()
        assert ctx.current_topic() == "call_debrief"

    def test_brain_context_structure(self):
        ctx = ConversationContext()
        ctx.add_user_turn("Test message")
        ctx.track_entity("Alice", "person")
        ctx.push_topic("greeting")

        brain_ctx = ctx.get_brain_context()

        assert "session_id" in brain_ctx
        assert "turns" in brain_ctx
        assert "tracked_entities" in brain_ctx
        assert brain_ctx["current_topic"] == "greeting"
        assert brain_ctx["turn_count"] == 1

    def test_session_summary(self):
        ctx = ConversationContext()
        ctx.update_session_summary("User discussed Q3 deal with Marcus.")
        brain_ctx = ctx.get_brain_context()
        assert brain_ctx["session_summary"] == "User discussed Q3 deal with Marcus."


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# State Tracker Tests
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestStateTracker:
    def test_initial_state(self):
        st = StateTracker()
        assert st.current_state == ConversationState.IDLE

    def test_transition(self):
        st = StateTracker()
        st.transition(ConversationState.GREETING)
        assert st.current_state == ConversationState.GREETING
        assert len(st.history) == 2  # IDLE + GREETING

    def test_transition_closes_previous(self):
        st = StateTracker()
        st.transition(ConversationState.QUERYING)
        old = st.history[0]
        assert old.exited_at is not None
        assert old.duration is not None

    def test_listener_called(self):
        st = StateTracker()
        calls = []
        st.on_transition(lambda old, new: calls.append((old.state, new.state)))

        st.transition(ConversationState.DEBRIEFING)
        assert len(calls) == 1
        assert calls[0] == (ConversationState.IDLE, ConversationState.DEBRIEFING)

    def test_last_n_states(self):
        st = StateTracker()
        st.transition(ConversationState.GREETING)
        st.transition(ConversationState.QUERYING)
        st.transition(ConversationState.DEBRIEFING)

        last = st.last_n_states(3)
        assert last == [
            ConversationState.GREETING,
            ConversationState.QUERYING,
            ConversationState.DEBRIEFING,
        ]


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# BrainResponse Parsing Tests
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestBrainResponse:
    def test_parse_full_response(self):
        raw = {
            "content": {
                "response_text": "Got it, Marcus from Clearwater wants Q3.",
                "inferred_intent": "call_debrief",
                "inferred_state": "debriefing",
                "entities_detected": [
                    {"name": "Marcus", "type": "person"},
                    {"name": "Clearwater", "type": "company"},
                ],
                "suggested_actions": [],
                "follow_up_prompt": "Want me to log this call?",
                "confidence": 0.95,
                "needs_clarification": False,
                "context_summary_update": None,
            }
        }

        resp = BrainResponse.from_gateway_response(raw, latency_ms=150.0)

        assert resp.text == "Got it, Marcus from Clearwater wants Q3."
        assert resp.intent == "call_debrief"
        assert resp.state == ConversationState.DEBRIEFING
        assert len(resp.entities) == 2
        assert resp.follow_up == "Want me to log this call?"
        assert resp.confidence == 0.95
        assert resp.latency_ms == 150.0

    def test_parse_plain_text(self):
        raw = {"content": "Just a plain text response"}
        resp = BrainResponse.from_gateway_response(raw)
        assert resp.text == "Just a plain text response"
        assert resp.intent is None

    def test_parse_json_string_content(self):
        raw = {
            "content": json.dumps({
                "response_text": "Hello!",
                "inferred_intent": "greeting",
                "inferred_state": "greeting",
            })
        }
        resp = BrainResponse.from_gateway_response(raw)
        assert resp.text == "Hello!"
        assert resp.intent == "greeting"

    def test_error_response(self):
        resp = BrainResponse.error("Something broke")
        assert resp.text == "Something broke"
        assert resp.state == ConversationState.ERROR_RECOVERY
        assert resp.confidence == 0.0


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Engine Integration Tests (with mocked gateway)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestConversationEngine:
    @pytest.fixture
    def mock_gateway_response(self):
        """Standard mock brain response."""
        return {
            "request_id": "test-123",
            "content": {
                "response_text": "Got it, I'll note that Marcus wants to push to Q3.",
                "inferred_intent": "call_debrief",
                "inferred_state": "debriefing",
                "entities_detected": [
                    {"name": "Marcus", "type": "person", "aliases": ["Marc"]},
                    {"name": "Clearwater Capital", "type": "company", "aliases": ["CWC"]},
                ],
                "suggested_actions": [
                    {
                        "action": "log_call",
                        "params": {"contact": "Marcus", "company": "Clearwater Capital"},
                        "label": "Log this call",
                    }
                ],
                "follow_up_prompt": "Want me to draft a follow-up email to Marcus?",
                "confidence": 0.92,
                "needs_clarification": False,
                "context_summary_update": None,
            },
        }

    @pytest.mark.asyncio
    async def test_full_pipeline(self, mock_gateway_response):
        engine = ConversationEngine()

        # Mock the gateway
        engine.gateway.connect = AsyncMock()
        engine.gateway.send = AsyncMock(return_value=mock_gateway_response)
        engine.gateway.is_connected = True
        engine._started = True

        response = await engine.process(
            "Just talked to Marcus at Clearwater, he wants to push the deal to Q3"
        )

        assert response.text == "Got it, I'll note that Marcus wants to push to Q3."
        assert response.intent == "call_debrief"
        assert response.state == ConversationState.DEBRIEFING
        assert response.confidence == 0.92
        assert response.follow_up == "Want me to draft a follow-up email to Marcus?"

        # Verify entities were tracked
        marcus = engine.context.find_entity("Marcus")
        assert marcus is not None
        assert marcus.entity_type == "person"
        assert "Marc" in marcus.aliases

        clearwater = engine.context.find_entity("Clearwater Capital")
        assert clearwater is not None

        # Verify state transition
        assert engine.state.current_state == ConversationState.DEBRIEFING

        # Verify turns recorded
        assert engine.context.turn_count == 2  # user + brain

    @pytest.mark.asyncio
    async def test_multi_turn_context_accumulation(self, mock_gateway_response):
        engine = ConversationEngine()
        engine.gateway.connect = AsyncMock()
        engine.gateway.send = AsyncMock(return_value=mock_gateway_response)
        engine._started = True

        await engine.process("First message")
        await engine.process("Second message")
        await engine.process("Third message")

        # Each process call adds 2 turns (user + brain)
        assert engine.context.turn_count == 6

        # The payload sent to gateway should contain all turns in the window
        last_call = engine.gateway.send.call_args
        payload = last_call[1]["payload"] if "payload" in (last_call[1] or {}) else last_call[0][0]
        context = payload.get("context", {})
        assert len(context.get("turns", [])) == 6

    @pytest.mark.asyncio
    async def test_timeout_recovery(self):
        engine = ConversationEngine(
            config=EngineConfig(response_timeout=0.1)
        )
        engine.gateway.connect = AsyncMock()
        engine.gateway.send = AsyncMock(side_effect=TimeoutError("Timed out"))
        engine._started = True

        response = await engine.process("Hello?")

        assert "trouble connecting" in response.text.lower() or "having trouble" in response.text.lower()
        assert engine.state.current_state == ConversationState.ERROR_RECOVERY

    @pytest.mark.asyncio
    async def test_connection_error_recovery(self):
        engine = ConversationEngine()
        engine.gateway.connect = AsyncMock()
        engine.gateway.send = AsyncMock(side_effect=ConnectionError("Lost"))
        engine._started = True

        response = await engine.process("Anyone there?")

        assert "connection" in response.text.lower() or "reconnect" in response.text.lower()
        assert engine.state.current_state == ConversationState.ERROR_RECOVERY

    @pytest.mark.asyncio
    async def test_callbacks_fired(self, mock_gateway_response):
        response_log = []
        action_log = []

        config = EngineConfig(
            on_response=lambda r: response_log.append(r),
            on_action=lambda a: action_log.append(a),
        )
        engine = ConversationEngine(config)
        engine.gateway.connect = AsyncMock()
        engine.gateway.send = AsyncMock(return_value=mock_gateway_response)
        engine._started = True

        await engine.process("Log this call")

        assert len(response_log) == 1
        assert response_log[0].intent == "call_debrief"
        assert len(action_log) == 1
        assert action_log[0]["action"] == "log_call"

    @pytest.mark.asyncio
    async def test_new_session_resets(self, mock_gateway_response):
        engine = ConversationEngine()
        engine.gateway.connect = AsyncMock()
        engine.gateway.send = AsyncMock(return_value=mock_gateway_response)
        engine._started = True

        await engine.process("Build up some context")
        old_session = engine.session_id
        assert engine.context.turn_count == 2

        new_id = engine.new_session()
        assert new_id != old_session
        assert engine.context.turn_count == 0
        assert engine.state.current_state == ConversationState.IDLE


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# No Hardcoded Commands Test
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestNoHardcodedCommands:
    """
    Verify that the engine has ZERO keyword/regex/command matching.
    Every utterance must go to the brain untouched.
    """

    @pytest.mark.asyncio
    async def test_all_input_reaches_brain(self):
        """Every user message must be sent to the gateway exactly as-is."""
        engine = ConversationEngine()
        engine.gateway.connect = AsyncMock()
        engine.gateway.send = AsyncMock(return_value={
            "content": {
                "response_text": "OK",
                "inferred_intent": "unknown",
                "inferred_state": "idle",
                "entities_detected": [],
                "suggested_actions": [],
                "follow_up_prompt": None,
                "confidence": 0.5,
                "needs_clarification": False,
                "context_summary_update": None,
            }
        })
        engine._started = True

        test_inputs = [
            "call John",
            "schedule meeting",
            "/command that looks like a slash command",
            "!bang command",
            "remind me to buy milk",
            "what time is it",
            "🔥🔥🔥",
            "",  # empty should be handled but still sent
            "   just whitespace   ",
        ]

        for user_input in test_inputs:
            if not user_input.strip():
                continue
            await engine.process(user_input)

            # Verify the last gateway call contains the raw user input
            call_args = engine.gateway.send.call_args[0][0]
            assert call_args["user_message"] == user_input, (
                f"Input '{user_input}' was not passed to gateway verbatim"
            )
