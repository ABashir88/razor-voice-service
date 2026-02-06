"""
Razor Brain — Conversation Intelligence Engine
================================================
Zero hardcoded commands. Every utterance flows through the OpenClaw AI gateway.
Intent, entities, state, and follow-ups are all inferred by the brain.
"""

from razor_brain.engine import ConversationEngine
from razor_brain.context import ConversationContext, Turn
from razor_brain.gateway import OpenClawGateway
from razor_brain.state import ConversationState, StateTracker

__all__ = [
    "ConversationEngine",
    "ConversationContext",
    "Turn",
    "OpenClawGateway",
    "ConversationState",
    "StateTracker",
]

__version__ = "1.0.0"
