"""
Conversation Context Manager
==============================
Maintains a rolling window of exchanges with full semantic context.
Handles implicit references, entity tracking, and multi-turn continuity.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class Role(str, Enum):
    USER = "user"
    BRAIN = "brain"
    SYSTEM = "system"


@dataclass
class Entity:
    """A tracked entity extracted from conversation (person, deal, company, etc.)."""

    id: str
    canonical_name: str
    entity_type: str  # person, company, deal, location, phone, etc.
    aliases: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    last_referenced_at: float = 0.0
    reference_count: int = 0

    def touch(self) -> None:
        self.last_referenced_at = time.time()
        self.reference_count += 1


@dataclass
class Turn:
    """A single conversational exchange."""

    id: str
    role: Role
    content: str
    timestamp: float
    entities_mentioned: list[str] = field(default_factory=list)  # entity IDs
    intent: Optional[str] = None
    metadata: dict[str, Any] = field(default_factory=dict)


class ConversationContext:
    """
    Full conversation memory with rolling window for the AI brain.

    - Stores ALL turns for audit/history
    - Sends a rolling window (configurable, default 20) to the brain
    - Tracks entities for implicit reference resolution
    - Maintains a session-level summary that compresses older context
    """

    def __init__(
        self,
        session_id: Optional[str] = None,
        window_size: int = 20,
        max_entities: int = 200,
    ):
        self.session_id = session_id or str(uuid.uuid4())
        self.window_size = window_size
        self.max_entities = max_entities

        self._turns: list[Turn] = []
        self._entities: dict[str, Entity] = {}
        self._session_summary: str = ""
        self._created_at: float = time.time()
        self._topic_stack: list[str] = []  # current conversation topics

    # ─── Turn Management ──────────────────────────────────────────────

    def add_user_turn(
        self,
        content: str,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Turn:
        turn = Turn(
            id=str(uuid.uuid4()),
            role=Role.USER,
            content=content,
            timestamp=time.time(),
            metadata=metadata or {},
        )
        self._turns.append(turn)
        return turn

    def add_brain_turn(
        self,
        content: str,
        intent: Optional[str] = None,
        entities: Optional[list[str]] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Turn:
        turn = Turn(
            id=str(uuid.uuid4()),
            role=Role.BRAIN,
            content=content,
            timestamp=time.time(),
            intent=intent,
            entities_mentioned=entities or [],
            metadata=metadata or {},
        )
        self._turns.append(turn)
        return turn

    def add_system_turn(self, content: str) -> Turn:
        turn = Turn(
            id=str(uuid.uuid4()),
            role=Role.SYSTEM,
            content=content,
            timestamp=time.time(),
        )
        self._turns.append(turn)
        return turn

    # ─── Entity Tracking ──────────────────────────────────────────────

    def track_entity(
        self,
        canonical_name: str,
        entity_type: str,
        aliases: Optional[list[str]] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Entity:
        """Register or update a tracked entity."""
        # Check if entity already exists by name or alias
        existing = self.find_entity(canonical_name)
        if existing:
            existing.touch()
            if aliases:
                for alias in aliases:
                    if alias.lower() not in [a.lower() for a in existing.aliases]:
                        existing.aliases.append(alias)
            if metadata:
                existing.metadata.update(metadata)
            return existing

        entity = Entity(
            id=str(uuid.uuid4()),
            canonical_name=canonical_name,
            entity_type=entity_type,
            aliases=aliases or [],
            metadata=metadata or {},
            last_referenced_at=time.time(),
            reference_count=1,
        )
        self._entities[entity.id] = entity

        # Evict least-recently-referenced entities if over limit
        if len(self._entities) > self.max_entities:
            self._evict_stale_entities()

        return entity

    def find_entity(self, name_or_alias: str) -> Optional[Entity]:
        """Find entity by canonical name or any alias (case-insensitive)."""
        needle = name_or_alias.lower().strip()
        for entity in self._entities.values():
            if entity.canonical_name.lower() == needle:
                return entity
            if any(a.lower() == needle for a in entity.aliases):
                return entity
        return None

    def get_recent_entities(self, limit: int = 10) -> list[Entity]:
        """Get most recently referenced entities for pronoun resolution."""
        sorted_entities = sorted(
            self._entities.values(),
            key=lambda e: e.last_referenced_at,
            reverse=True,
        )
        return sorted_entities[:limit]

    def get_entities_by_type(self, entity_type: str) -> list[Entity]:
        return [
            e
            for e in self._entities.values()
            if e.entity_type == entity_type
        ]

    def _evict_stale_entities(self) -> None:
        sorted_entities = sorted(
            self._entities.values(),
            key=lambda e: (e.reference_count, e.last_referenced_at),
        )
        to_remove = len(self._entities) - self.max_entities
        for entity in sorted_entities[:to_remove]:
            del self._entities[entity.id]

    # ─── Topic Stack ──────────────────────────────────────────────────

    def push_topic(self, topic: str) -> None:
        if not self._topic_stack or self._topic_stack[-1] != topic:
            self._topic_stack.append(topic)
            if len(self._topic_stack) > 20:
                self._topic_stack = self._topic_stack[-20:]

    def current_topic(self) -> Optional[str]:
        return self._topic_stack[-1] if self._topic_stack else None

    def pop_topic(self) -> Optional[str]:
        return self._topic_stack.pop() if self._topic_stack else None

    # ─── Context Window for Brain ─────────────────────────────────────

    def get_brain_context(self) -> dict[str, Any]:
        """
        Build the full context payload sent to the OpenClaw brain.
        This is the brain's entire understanding of the conversation.
        """
        window_turns = self._turns[-self.window_size :]
        recent_entities = self.get_recent_entities(15)

        return {
            "session_id": self.session_id,
            "session_summary": self._session_summary,
            "current_topic": self.current_topic(),
            "topic_history": self._topic_stack[-5:],
            "turns": [
                {
                    "role": t.role.value,
                    "content": t.content,
                    "timestamp": t.timestamp,
                    "intent": t.intent,
                    "entities": t.entities_mentioned,
                }
                for t in window_turns
            ],
            "tracked_entities": [
                {
                    "id": e.id,
                    "name": e.canonical_name,
                    "type": e.entity_type,
                    "aliases": e.aliases,
                    "metadata": e.metadata,
                    "ref_count": e.reference_count,
                }
                for e in recent_entities
            ],
            "turn_count": len(self._turns),
            "session_age_seconds": time.time() - self._created_at,
        }

    def update_session_summary(self, summary: str) -> None:
        """Called when the brain compresses older context into a summary."""
        self._session_summary = summary

    # ─── Serialization ────────────────────────────────────────────────

    @property
    def turn_count(self) -> int:
        return len(self._turns)

    @property
    def all_turns(self) -> list[Turn]:
        return list(self._turns)

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "created_at": self._created_at,
            "turn_count": len(self._turns),
            "entity_count": len(self._entities),
            "current_topic": self.current_topic(),
            "session_summary": self._session_summary,
        }
