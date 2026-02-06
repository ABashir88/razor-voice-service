"""
Razor Brain — Conversation Engine
====================================
The main orchestrator. Every user utterance flows through here:

  Transcript → Context enrichment → Brain payload → Gateway → Response parsing
            → Entity extraction → State transition → Follow-up chaining

Zero hardcoded commands. The brain handles all understanding.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from razor_brain.context import ConversationContext, Entity, Role
from razor_brain.gateway import GatewayConfig, OpenClawGateway
from razor_brain.prompts import build_brain_payload
from razor_brain.state import ConversationState, StateTracker

logger = logging.getLogger("razor.engine")


# ─── Response Model ───────────────────────────────────────────────────

@dataclass
class BrainResponse:
    """Parsed response from the OpenClaw brain."""

    text: str
    intent: Optional[str] = None
    state: Optional[ConversationState] = None
    entities: list[dict[str, Any]] = field(default_factory=list)
    suggested_actions: list[dict[str, Any]] = field(default_factory=list)
    follow_up: Optional[str] = None
    confidence: float = 1.0
    needs_clarification: bool = False
    context_summary_update: Optional[str] = None
    raw: dict[str, Any] = field(default_factory=dict)
    latency_ms: float = 0.0

    @classmethod
    def from_gateway_response(cls, data: dict[str, Any], latency_ms: float = 0.0) -> BrainResponse:
        """Parse the brain's JSON response into a structured BrainResponse."""
        # The brain's actual response content may be nested under "content" or at top level
        content = data.get("content", data)

        # Handle the case where content is a JSON string
        if isinstance(content, str):
            try:
                content = json.loads(content)
            except json.JSONDecodeError:
                # Plain text response — wrap it
                return cls(
                    text=content,
                    raw=data,
                    latency_ms=latency_ms,
                )

        # Map inferred_state string to enum
        state = None
        raw_state = content.get("inferred_state")
        if raw_state:
            try:
                state = ConversationState(raw_state)
            except ValueError:
                logger.warning("Unknown state from brain: %s", raw_state)

        return cls(
            text=content.get("response_text", ""),
            intent=content.get("inferred_intent"),
            state=state,
            entities=content.get("entities_detected", []),
            suggested_actions=content.get("suggested_actions", []),
            follow_up=content.get("follow_up_prompt"),
            confidence=content.get("confidence", 1.0),
            needs_clarification=content.get("needs_clarification", False),
            context_summary_update=content.get("context_summary_update"),
            raw=data,
            latency_ms=latency_ms,
        )

    @classmethod
    def error(cls, message: str) -> BrainResponse:
        return cls(
            text=message,
            intent="error",
            state=ConversationState.ERROR_RECOVERY,
            confidence=0.0,
        )


# ─── Engine Configuration ────────────────────────────────────────────

@dataclass
class EngineConfig:
    """Configuration for the conversation engine."""

    gateway: GatewayConfig = field(default_factory=GatewayConfig)
    context_window_size: int = 20
    max_entities: int = 200
    auto_compress_at: int = 30        # compress context after N turns
    response_timeout: float = 60.0
    system_prompt_override: Optional[str] = None
    on_response: Optional[Callable[[BrainResponse], None]] = None
    on_action: Optional[Callable[[dict[str, Any]], None]] = None
    on_error: Optional[Callable[[Exception], None]] = None


# ─── The Engine ───────────────────────────────────────────────────────

class ConversationEngine:
    """
    The core Razor Brain engine.

    Usage:
        engine = ConversationEngine()
        await engine.start()
        response = await engine.process("I just got off the phone with Clearwater")
        print(response.text)
        # ... more turns ...
        await engine.stop()
    """

    def __init__(self, config: Optional[EngineConfig] = None) -> None:
        self.config = config or EngineConfig()

        self.context = ConversationContext(
            window_size=self.config.context_window_size,
            max_entities=self.config.max_entities,
        )
        self.gateway = OpenClawGateway(config=self.config.gateway)
        self.state = StateTracker()

        self._started = False
        self._processing = False

    # ─── Lifecycle ────────────────────────────────────────────────────

    async def start(self) -> None:
        """Initialize the engine and connect to the brain."""
        if self._started:
            return

        logger.info("Starting Razor Brain engine (session=%s)", self.context.session_id)
        await self.gateway.connect()
        self._started = True
        logger.info("Razor Brain engine ready")

    async def stop(self) -> None:
        """Gracefully shut down the engine."""
        logger.info("Stopping Razor Brain engine")
        await self.gateway.disconnect()
        self._started = False
        logger.info("Razor Brain engine stopped")

    async def __aenter__(self) -> ConversationEngine:
        await self.start()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.stop()

    # ─── Main Processing Pipeline ─────────────────────────────────────

    async def process(
        self,
        user_input: str,
        metadata: Optional[dict[str, Any]] = None,
        stream_callback: Optional[Callable[[str], None]] = None,
    ) -> BrainResponse:
        """
        Process a user utterance through the full pipeline.

        This is the ONLY entry point for user input. Everything flows through
        the AI brain — no local command matching of any kind.

        Args:
            user_input: Raw transcribed text from the user.
            metadata: Optional metadata (source, audio confidence, etc.).
            stream_callback: If provided, receives streaming text chunks.

        Returns:
            BrainResponse with the brain's full parsed response.
        """
        if not self._started:
            await self.start()

        self._processing = True
        start_time = time.time()

        try:
            # ① Record the user turn
            user_turn = self.context.add_user_turn(
                content=user_input,
                metadata=metadata,
            )

            # ② Check if we need to compress context
            if self.context.turn_count > self.config.auto_compress_at:
                await self._maybe_compress_context()

            # ③ Build the brain payload
            brain_context = self.context.get_brain_context()
            payload = build_brain_payload(
                user_message=user_input,
                context=brain_context,
                system_prompt_override=self.config.system_prompt_override,
            )

            # ④ Send to the brain via gateway
            raw_response = await self.gateway.send(
                payload=payload,
                timeout=self.config.response_timeout,
                stream_callback=stream_callback,
            )

            # ⑤ Parse the response
            latency_ms = (time.time() - start_time) * 1000
            response = BrainResponse.from_gateway_response(raw_response, latency_ms)

            # ⑥ Update context with brain's response
            brain_turn = self.context.add_brain_turn(
                content=response.text,
                intent=response.intent,
                entities=[e.get("name", "") for e in response.entities],
                metadata={
                    "confidence": response.confidence,
                    "latency_ms": response.latency_ms,
                    "actions": response.suggested_actions,
                },
            )

            # ⑦ Track entities the brain detected
            self._process_entities(response.entities)

            # ⑧ Update conversation state
            if response.state:
                self.state.transition(
                    new_state=response.state,
                    trigger_turn_id=user_turn.id,
                    metadata={"intent": response.intent},
                )

            # ⑨ Update context summary if brain provided one
            if response.context_summary_update:
                self.context.update_session_summary(response.context_summary_update)

            # ⑩ Update topic if intent changed
            if response.intent:
                self.context.push_topic(response.intent)

            # ⑪ Fire callbacks
            if self.config.on_response:
                try:
                    self.config.on_response(response)
                except Exception as exc:
                    logger.warning("on_response callback error: %s", exc)

            if response.suggested_actions and self.config.on_action:
                for action in response.suggested_actions:
                    try:
                        self.config.on_action(action)
                    except Exception as exc:
                        logger.warning("on_action callback error: %s", exc)

            logger.info(
                "Processed turn %d: intent=%s state=%s confidence=%.2f latency=%.0fms",
                self.context.turn_count,
                response.intent,
                response.state.value if response.state else "—",
                response.confidence,
                response.latency_ms,
            )

            return response

        except TimeoutError:
            error_resp = BrainResponse.error(
                "I'm having trouble connecting to my brain right now. "
                "Could you repeat that in a moment?"
            )
            self.context.add_brain_turn(
                content=error_resp.text, intent="error"
            )
            self.state.transition(ConversationState.ERROR_RECOVERY)
            if self.config.on_error:
                self.config.on_error(TimeoutError("Brain timeout"))
            return error_resp

        except ConnectionError as exc:
            error_resp = BrainResponse.error(
                "I've lost my connection. Give me a second to reconnect."
            )
            self.context.add_brain_turn(
                content=error_resp.text, intent="error"
            )
            self.state.transition(ConversationState.ERROR_RECOVERY)
            if self.config.on_error:
                self.config.on_error(exc)
            return error_resp

        except Exception as exc:
            logger.exception("Unexpected error processing turn: %s", exc)
            error_resp = BrainResponse.error(
                "Something went wrong on my end. Let me try again."
            )
            self.context.add_brain_turn(
                content=error_resp.text, intent="error"
            )
            self.state.transition(ConversationState.ERROR_RECOVERY)
            if self.config.on_error:
                self.config.on_error(exc)
            return error_resp

        finally:
            self._processing = False

    # ─── Entity Processing ────────────────────────────────────────────

    def _process_entities(self, entities: list[dict[str, Any]]) -> None:
        """Register entities the brain detected in the latest exchange."""
        for entity_data in entities:
            name = entity_data.get("name")
            if not name:
                continue
            self.context.track_entity(
                canonical_name=name,
                entity_type=entity_data.get("type", "other"),
                aliases=entity_data.get("aliases", []),
                metadata={
                    k: v
                    for k, v in entity_data.items()
                    if k not in ("name", "type", "aliases")
                },
            )

    # ─── Context Compression ─────────────────────────────────────────

    async def _maybe_compress_context(self) -> None:
        """
        Ask the brain to summarize older context when the window is getting large.
        This keeps the rolling window efficient without losing important information.
        """
        if self.context.turn_count < self.config.auto_compress_at:
            return

        # Only compress every N turns after the threshold
        if self.context.turn_count % 10 != 0:
            return

        logger.info("Requesting context compression from brain")

        compress_payload = {
            "type": "context_compress",
            "system_prompt": (
                "Summarize this conversation history into a concise paragraph. "
                "Preserve: all entity names, key decisions, action items, "
                "unresolved questions, and the current topic. "
                "Respond with ONLY the summary text, no JSON."
            ),
            "user_message": "Please compress the conversation context.",
            "context": self.context.get_brain_context(),
        }

        try:
            raw = await self.gateway.send(compress_payload, timeout=30.0)
            summary = raw.get("content", "")
            if isinstance(summary, dict):
                summary = summary.get("response_text", str(summary))
            if summary:
                self.context.update_session_summary(summary)
                logger.info("Context compressed: %d chars", len(summary))
        except Exception as exc:
            logger.warning("Context compression failed (non-critical): %s", exc)

    # ─── Session Management ───────────────────────────────────────────

    def new_session(self) -> str:
        """Start a fresh conversation session, preserving entity knowledge."""
        old_session = self.context.session_id
        self.context = ConversationContext(
            window_size=self.config.context_window_size,
            max_entities=self.config.max_entities,
        )
        self.state = StateTracker()
        logger.info(
            "New session %s (replaced %s)",
            self.context.session_id,
            old_session,
        )
        return self.context.session_id

    # ─── Introspection ────────────────────────────────────────────────

    @property
    def is_processing(self) -> bool:
        return self._processing

    @property
    def session_id(self) -> str:
        return self.context.session_id

    def status(self) -> dict[str, Any]:
        """Full engine status for monitoring / debugging."""
        return {
            "session": self.context.to_dict(),
            "state": self.state.to_dict(),
            "gateway": self.gateway.health_report(),
            "config": {
                "context_window": self.config.context_window_size,
                "auto_compress_at": self.config.auto_compress_at,
                "response_timeout": self.config.response_timeout,
            },
        }
