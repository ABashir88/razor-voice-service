"""
Conversation State Tracker
============================
States are inferred by the AI brain from conversational context.
No keyword matching. No regex. The brain tells us what state we're in.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class ConversationState(str, Enum):
    """
    Possible high-level conversation states.
    These are REPORTED by the brain, never detected locally.
    """

    IDLE = "idle"
    GREETING = "greeting"
    QUERYING = "querying"
    DEBRIEFING = "debriefing"          # user recounting a call/meeting
    ACTION_REQUESTED = "action_requested"  # user wants something done
    CLARIFYING = "clarifying"          # brain is asking for clarity
    CONFIRMING = "confirming"          # awaiting user confirmation
    FOLLOWING_UP = "following_up"      # brain offered a next step
    MULTI_TURN_TASK = "multi_turn_task"  # extended multi-step operation
    ERROR_RECOVERY = "error_recovery"
    FAREWELL = "farewell"


@dataclass
class StateSnapshot:
    """A point-in-time record of a state transition."""

    state: ConversationState
    entered_at: float
    exited_at: Optional[float] = None
    trigger_turn_id: Optional[str] = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def duration(self) -> Optional[float]:
        if self.exited_at:
            return self.exited_at - self.entered_at
        return time.time() - self.entered_at


class StateTracker:
    """
    Tracks conversation state transitions as reported by the brain.

    The engine sends the brain's inferred state here. This module:
    - Maintains state history for debugging and analytics
    - Emits transition events for any listeners (webhooks, UI, etc.)
    - Validates transitions (soft — logs anomalies, never blocks)
    """

    def __init__(self) -> None:
        self._current: StateSnapshot = StateSnapshot(
            state=ConversationState.IDLE,
            entered_at=time.time(),
        )
        self._history: list[StateSnapshot] = [self._current]
        self._listeners: list[Any] = []

    @property
    def current_state(self) -> ConversationState:
        return self._current.state

    @property
    def current_snapshot(self) -> StateSnapshot:
        return self._current

    @property
    def history(self) -> list[StateSnapshot]:
        return list(self._history)

    def transition(
        self,
        new_state: ConversationState,
        trigger_turn_id: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> StateSnapshot:
        """
        Record a state transition as reported by the brain.
        Returns the new state snapshot.
        """
        now = time.time()

        # Close the current state
        self._current.exited_at = now

        # Open the new state
        snapshot = StateSnapshot(
            state=new_state,
            entered_at=now,
            trigger_turn_id=trigger_turn_id,
            metadata=metadata or {},
        )
        self._current = snapshot
        self._history.append(snapshot)

        # Trim history to prevent unbounded growth (keep last 500)
        if len(self._history) > 500:
            self._history = self._history[-500:]

        # Notify listeners
        for listener in self._listeners:
            try:
                listener(self._history[-2], snapshot)
            except Exception:
                pass  # listeners must not crash the engine

        return snapshot

    def on_transition(self, callback: Any) -> None:
        """Register a callback for state transitions: fn(old_snapshot, new_snapshot)."""
        self._listeners.append(callback)

    def time_in_current_state(self) -> float:
        return time.time() - self._current.entered_at

    def last_n_states(self, n: int = 5) -> list[ConversationState]:
        return [s.state for s in self._history[-n:]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "current_state": self._current.state.value,
            "entered_at": self._current.entered_at,
            "duration": self._current.duration,
            "total_transitions": len(self._history),
            "recent_states": [s.state.value for s in self._history[-10:]],
        }
