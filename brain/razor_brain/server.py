"""
Razor Brain Server — FastAPI + Claude API
==========================================
Intelligence Agent that processes sales conversations using Claude AI.
Exposes WebSocket and REST endpoints for the Razor voice pipeline.

Architecture:
  - FastAPI server on 127.0.0.1:8780
  - Claude API (Sonnet 4.5) for conversation intelligence
  - Sales coaching system prompt with objection handling
  - WebSocket protocol for real-time conversation processing
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Optional

from anthropic import AsyncAnthropic
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# ─── Configuration ────────────────────────────────────────────────────

# Load environment variables from .env file in project root
env_path = os.path.join(os.path.dirname(__file__), "../../.env")
env_path = os.path.abspath(env_path)
loaded = load_dotenv(dotenv_path=env_path, override=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("razor.brain")

logger.info(f"Loaded .env from: {env_path}, success: {loaded}")

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
if not ANTHROPIC_API_KEY:
    logger.warning("ANTHROPIC_API_KEY not set — brain will fail at runtime")
else:
    logger.info(f"ANTHROPIC_API_KEY loaded (length: {len(ANTHROPIC_API_KEY)}, first 10 chars: {ANTHROPIC_API_KEY[:10]}...)")

ANTHROPIC_BASE_URL = os.getenv("ANTHROPIC_BASE_URL", "")
if ANTHROPIC_BASE_URL:
    logger.info(f"Using custom base URL: {ANTHROPIC_BASE_URL}")

MODEL_NAME = "claude-sonnet-4-20250514"
MAX_TOKENS = 75
TEMPERATURE = 0.0

# ─── Sales Coaching System Prompt ─────────────────────────────────────
# Loaded from SYSTEM_PROMPT.md at module init for easy editing.

_prompt_path = os.path.join(os.path.dirname(__file__), "SYSTEM_PROMPT.md")
try:
    with open(_prompt_path, "r") as f:
        SALES_COACH_SYSTEM_PROMPT = f.read()
    logger.info("Loaded system prompt from %s (%d chars)", _prompt_path, len(SALES_COACH_SYSTEM_PROMPT))
except FileNotFoundError:
    logger.error("SYSTEM_PROMPT.md not found at %s — using fallback", _prompt_path)
    SALES_COACH_SYSTEM_PROMPT = "You are Razor, a sharp AI sales coach. Be concise (max 2 sentences). Respond in JSON: {\"text\":\"...\",\"intent\":\"...\",\"entities\":[],\"actions\":[],\"state\":\"...\",\"confidence\":0.9}"

# ─── Quick Response Cache ────────────────────────────────────────────
# Instant responses for common queries — bypasses Claude API entirely.
# Keys are lowercase stripped. Value is a partial BrainResponse dict.

QUICK_RESPONSES: dict[str, dict] = {
    "hello":          {"text": "What's up?", "intent": "greeting"},
    "hey":            {"text": "Talk to me.", "intent": "greeting"},
    "hi":             {"text": "What's up?", "intent": "greeting"},
    "yo":             {"text": "Talk to me.", "intent": "greeting"},
    "hey razor":      {"text": "What do you need?", "intent": "greeting"},
    "hi razor":       {"text": "What do you need?", "intent": "greeting"},
    "hello razor":    {"text": "What's up?", "intent": "greeting"},
    "what's up":      {"text": "Ready when you are.", "intent": "greeting"},
    "good morning":   {"text": "Morning. What's the play today?", "intent": "greeting"},
    "good afternoon":  {"text": "What do you need?", "intent": "greeting"},
    "good evening":   {"text": "Still grinding? What do you need?", "intent": "greeting"},
    "thanks":         {"text": "Got it.", "intent": "acknowledgment"},
    "thank you":      {"text": "Anytime.", "intent": "acknowledgment"},
    "thanks razor":   {"text": "Got it.", "intent": "acknowledgment"},
    "never mind":     {"text": "Cool.", "intent": "cancel"},
    "cancel":         {"text": "Done.", "intent": "cancel"},
    "stop":           {"text": "Done.", "intent": "cancel"},
    "nothing":        {"text": "Cool.", "intent": "cancel"},
    "bye":            {"text": "Later.", "intent": "farewell"},
    "goodbye":        {"text": "Later.", "intent": "farewell"},
    "see you":        {"text": "Later.", "intent": "farewell"},
}


def _check_quick_response(text: str) -> dict | None:
    """Check if user text matches a cached quick response."""
    key = text.strip().lower().rstrip(".,!?")
    return QUICK_RESPONSES.get(key)


# ─── Fallback Action Detection ────────────────────────────────────────
# When brain fails to emit actions, detect from the user's raw query.
# Uses simple keyword matching as a safety net — brain prompt should
# handle this 95% of the time, this catches the remaining 5%.

import re as _re

_ACTION_PATTERNS: list[tuple[_re.Pattern, dict]] = [
    # ═══════════════════════════════════════════════════════════════════
    # SALESFORCE
    # ═══════════════════════════════════════════════════════════════════
    (_re.compile(r"(pipeline|how much pipeline|my pipeline|quota)", _re.I),
     {"action": "get_pipeline", "params": {}}),
    (_re.compile(r"(biggest deal|largest deal|biggest opportunity)", _re.I),
     {"action": "get_biggest_deal", "params": {}}),
    (_re.compile(r"(stale deals?|deals? gone dark|neglected deals?|deals? at risk)", _re.I),
     {"action": "get_stale_deals", "params": {}}),
    (_re.compile(r"(closing this week|deals? closing this week|what.?s closing soon)", _re.I),
     {"action": "get_deals_closing", "params": {"period": "this_week"}}),
    (_re.compile(r"(closing this month|deals? closing this month)", _re.I),
     {"action": "get_deals_closing", "params": {"period": "this_month"}}),
    (_re.compile(r"(my tasks?|salesforce tasks?|sf tasks?)", _re.I),
     {"action": "get_sf_tasks", "params": {}}),
    (_re.compile(r"(upcoming tasks?|tasks? this week)", _re.I),
     {"action": "get_upcoming_tasks", "params": {}}),
    (_re.compile(r"decision maker", _re.I),
     {"action": "get_decision_maker", "params": {}}),

    # ═══════════════════════════════════════════════════════════════════
    # SALESLOFT
    # ═══════════════════════════════════════════════════════════════════
    (_re.compile(r"(hot leads?|who.?s engaged|any hot prospects?|buying signals?)", _re.I),
     {"action": "get_hot_leads", "params": {}}),
    (_re.compile(r"(who opened|email opens?|who opened my emails?)", _re.I),
     {"action": "get_email_opens", "params": {}}),
    (_re.compile(r"(who clicked|email clicks?|who clicked my emails?|any clicks?)", _re.I),
     {"action": "get_email_clicks", "params": {}}),
    (_re.compile(r"(any replies?|who replied|replies)", _re.I),
     {"action": "get_replies", "params": {}}),
    (_re.compile(r"(activity stats?|my numbers?|how many calls|my activity)", _re.I),
     {"action": "get_activity_stats", "params": {}}),
    (_re.compile(r"(my cadences?|active cadences?)", _re.I),
     {"action": "get_my_cadences", "params": {}}),

    # ═══════════════════════════════════════════════════════════════════
    # FELLOW
    # ═══════════════════════════════════════════════════════════════════
    (_re.compile(r"(my action items?|action items?|what are my action items?|to.?dos? from meetings?)", _re.I),
     {"action": "get_action_items", "params": {}}),
    (_re.compile(r"(overdue items?|overdue tasks?|any overdue)", _re.I),
     {"action": "get_overdue_items", "params": {}}),
    (_re.compile(r"(last meeting|how did my last call go|last meeting summary|last call)", _re.I),
     {"action": "last_meeting", "params": {}}),
    (_re.compile(r"(today.?s meetings?|meetings? today|what meetings? do i have)", _re.I),
     {"action": "get_today_meetings", "params": {}}),
    (_re.compile(r"(recent recordings?|recordings? this week|any recordings?)", _re.I),
     {"action": "get_recordings", "params": {}}),
    (_re.compile(r"(transcript|show transcript|last transcript)", _re.I),
     {"action": "get_transcript", "params": {}}),
    (_re.compile(r"(talk ratio|how much did i talk)", _re.I),
     {"action": "get_talk_ratio", "params": {}}),

    # ═══════════════════════════════════════════════════════════════════
    # GOOGLE
    # ═══════════════════════════════════════════════════════════════════
    (_re.compile(r"(what.?s on my calendar|calendar|my schedule|meetings? this week)", _re.I),
     {"action": "check_calendar", "params": {"days": 1}}),
    (_re.compile(r"(check my email|any new emails?|unread emails?|check email)", _re.I),
     {"action": "get_unread_emails", "params": {}}),
    (_re.compile(r"(free slots?|am i free|when am i free)", _re.I),
     {"action": "find_free_time", "params": {}}),

    # ═══════════════════════════════════════════════════════════════════
    # OTHER
    # ═══════════════════════════════════════════════════════════════════
    (_re.compile(r"(briefing|brief me|morning briefing|daily briefing|catch me up|what.?s happening)", _re.I),
     {"action": "morning_briefing", "params": {}}),
    (_re.compile(r"remind me", _re.I),
     {"action": "create_reminder", "params": {}}),
    (_re.compile(r"(log.*(call|meeting|activity)|record.*(call|meeting))", _re.I),
     {"action": "log_call", "params": {}}),
    (_re.compile(r"(prep me|prepare.*(for|me)|meeting prep)", _re.I),
     {"action": "meeting_prep", "params": {}}),
    (_re.compile(r"(search.*(web|for)|research)", _re.I),
     {"action": "research", "params": {"query": ""}}),

    # ═══════════════════════════════════════════════════════════════════
    # COMPOSITE — Priority Engine
    # ═══════════════════════════════════════════════════════════════════
    (_re.compile(r"what should i (?:be doing|do|focus on|work on)", _re.I),
     {"action": "get_priorities", "params": {}}),
    (_re.compile(r"what(?:'s| is) (?:my priority|on my plate|needs? attention)", _re.I),
     {"action": "get_priorities", "params": {}}),
    (_re.compile(r"priorit(?:y|ies)", _re.I),
     {"action": "get_priorities", "params": {}}),
    (_re.compile(r"what(?:'s| is) (?:important|urgent)", _re.I),
     {"action": "get_priorities", "params": {}}),

    # ═══════════════════════════════════════════════════════════════════
    # FELLOW — additional patterns (broader matching)
    # ═══════════════════════════════════════════════════════════════════
    (_re.compile(r"talk(?:ing)?\s*ratio|how much (?:did I|am I) talk", _re.I),
     {"action": "get_talk_ratio", "params": {}}),
    (_re.compile(r"action items?|to.?dos?|(?:my |are my )?tasks(?:\s|$|\?|\.)", _re.I),
     {"action": "get_action_items", "params": {}}),
    (_re.compile(r"last (?:meeting|call)|how (?:did|was) my (?:last )?call", _re.I),
     {"action": "last_meeting", "params": {}}),
    (_re.compile(r"recent recordings?|call recordings?|my recordings?", _re.I),
     {"action": "get_recordings", "params": {}}),

    # ═══════════════════════════════════════════════════════════════════
    # GOOGLE — additional patterns
    # ═══════════════════════════════════════════════════════════════════
    (_re.compile(r"my schedule|what(?:'s| is) on (?:my )?(?:calendar|schedule)|meetings? today", _re.I),
     {"action": "check_calendar", "params": {}}),
    (_re.compile(r"unread (?:email|mail)s?|new (?:email|mail)s?", _re.I),
     {"action": "get_unread_emails", "params": {}}),

    # ═══════════════════════════════════════════════════════════════════
    # SALESFORCE — additional patterns
    # ═══════════════════════════════════════════════════════════════════
    (_re.compile(r"(?:deals?|opportunities?) (?:gone )?(?:dark|cold|stale|quiet|overdue|stuck)|(?:stale|overdue|stuck) deals?", _re.I),
     {"action": "get_stale_deals", "params": {}}),
    (_re.compile(r"(?:deals?|opportunities?) closing|closing (?:this |next )?(?:week|month)", _re.I),
     {"action": "get_deals_closing", "params": {}}),

    # ═══════════════════════════════════════════════════════════════════
    # SALESLOFT — additional patterns (broader matching)
    # ═══════════════════════════════════════════════════════════════════
    (_re.compile(r"who(?:'s| has| is)? (?:opened|engaged|active|responding)", _re.I),
     {"action": "get_email_opens", "params": {}}),
    (_re.compile(r"(?:there|are there|any) (?:clicks?|opens?)", _re.I),
     {"action": "get_email_clicks", "params": {}}),
    (_re.compile(r"email (?:activity|engagement)", _re.I),
     {"action": "get_email_opens", "params": {}}),
]

# Contact lookup — checked last because it's broad (any "look up X" or "find X")
_CONTACT_PATTERN = _re.compile(
    r"\b(look\s*up|find|search\s*for|who\s*is|tell me about|what.?s\s+\w+.?s\s+(phone|email|number|contact))\b",
    _re.I,
)

def _detect_actions_from_query(text: str) -> list[dict]:
    """Detect actions from user query as fallback when brain doesn't emit them."""
    lower = text.lower()

    for pattern, action_template in _ACTION_PATTERNS:
        if pattern.search(lower):
            action = dict(action_template)  # shallow copy
            # Fill in query param for research
            if action["action"] == "research":
                action["params"] = {"query": text}
            return [action]

    # Contact lookup (broad — check last)
    if _CONTACT_PATTERN.search(lower):
        # Extract name: take last 1-3 capitalized words or everything after "look up"/"find"
        name_match = _re.search(r"(?:look\s*up|find|search\s*for|who\s*is)\s+(.+?)(?:\?|$|'s)", text, _re.I)
        name = name_match.group(1).strip() if name_match else text
        return [{"action": "lookup_contact", "params": {"name": name}}]

    return []


# ─── Models ───────────────────────────────────────────────────────────

class WebSocketMessage(BaseModel):
    """Incoming WebSocket message from voice pipeline"""
    text: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    stream: bool = False
    request_id: str = Field(default_factory=lambda: f"req_{uuid.uuid4().hex[:12]}")


class BrainResponse(BaseModel):
    """Outgoing response to voice pipeline"""
    type: str = "response"
    request_id: str
    text: str
    intent: str = "question"
    entities: list[dict[str, Any]] = Field(default_factory=list)
    actions: list[dict[str, Any]] = Field(default_factory=list)
    state: str = "listening"
    latency_ms: float = 0.0


class SessionResponse(BaseModel):
    """Response for /session/new"""
    session_id: str


class HealthResponse(BaseModel):
    """Response for /health"""
    status: str = "ok"
    model: str = MODEL_NAME


# ─── Brain Engine ─────────────────────────────────────────────────────

class BrainEngine:
    """Claude-powered conversation intelligence engine"""

    def __init__(self):
        self.client: Optional[AsyncAnthropic] = None
        self.sessions: dict[str, list[dict[str, str]]] = {}

    async def start(self):
        """Initialize Claude API client"""
        if ANTHROPIC_API_KEY:
            client_kwargs = {"api_key": ANTHROPIC_API_KEY}
            if ANTHROPIC_BASE_URL:
                client_kwargs["base_url"] = ANTHROPIC_BASE_URL
            self.client = AsyncAnthropic(**client_kwargs)
            logger.info("Brain engine started with model: %s", MODEL_NAME)
        else:
            logger.error("Cannot start brain engine: ANTHROPIC_API_KEY not set")

    async def stop(self):
        """Cleanup"""
        if self.client:
            await self.client.close()
        logger.info("Brain engine stopped")

    def new_session(self) -> str:
        """Create a new conversation session"""
        session_id = f"session_{uuid.uuid4().hex[:16]}"
        self.sessions[session_id] = []
        logger.info("Created session: %s", session_id)
        return session_id

    async def process(
        self,
        text: str,
        metadata: dict[str, Any],
        request_id: str,
        session_id: Optional[str] = None,
        websocket: Optional[WebSocket] = None,
    ) -> BrainResponse:
        """
        Process user utterance through Claude AI.

        Args:
            text: User's transcribed speech
            metadata: Additional context (source, confidence, etc.)
            request_id: Request ID for tracking
            session_id: Optional session ID for conversation continuity
            websocket: Optional WebSocket for streaming chunks

        Returns:
            Structured BrainResponse with text, intent, entities, actions
        """
        start_time = time.time()

        # ── TIMING: Quick response cache check ──
        t_cache = time.time()
        quick = _check_quick_response(text)
        if quick:
            latency_ms = (time.time() - start_time) * 1000
            logger.info(
                "CACHED response: '%s' → '%s' (%.0fms)",
                text, quick["text"], latency_ms
            )
            return BrainResponse(
                request_id=request_id,
                text=quick["text"],
                intent=quick.get("intent", "greeting"),
                state="listening",
                latency_ms=latency_ms
            )
        t_cache_done = time.time()

        if not self.client:
            return BrainResponse(
                request_id=request_id,
                text="Brain not initialized. Missing ANTHROPIC_API_KEY.",
                intent="error",
                state="error"
            )

        # ── TIMING: Build messages ──
        t_build = time.time()
        history = []
        if session_id and session_id in self.sessions:
            history = self.sessions[session_id][-10:]  # Last 10 turns

        messages = []
        for h in history:
            messages.append({"role": h["role"], "content": h["content"]})
        messages.append({"role": "user", "content": text})
        t_build_done = time.time()

        try:
            # ── TIMING: Claude API call (streaming) ──
            t_api = time.time()
            response_text = ""
            t_first_token = None

            tts_chunk_sent = False

            async with self.client.messages.stream(
                model=MODEL_NAME,
                max_tokens=MAX_TOKENS,
                temperature=TEMPERATURE,
                system=SALES_COACH_SYSTEM_PROMPT,
                messages=messages
            ) as stream:
                async for chunk in stream.text_stream:
                    if t_first_token is None:
                        t_first_token = time.time()
                    response_text += chunk

                    if websocket:
                        # Send raw streaming chunk
                        try:
                            await websocket.send_json({
                                "type": "stream_chunk",
                                "request_id": request_id,
                                "content": chunk,
                            })
                        except Exception:
                            pass

                        # Extract "text" field for early TTS pre-synthesis
                        if not tts_chunk_sent:
                            text_match = _re.search(
                                r'"text"\s*:\s*"((?:[^"\\]|\\.)*)"',
                                response_text,
                            )
                            if text_match:
                                tts_text = text_match.group(1).strip()
                                if tts_text and tts_text != ".":
                                    tts_chunk_sent = True
                                    try:
                                        await websocket.send_json({
                                            "type": "tts_chunk",
                                            "request_id": request_id,
                                            "text": tts_text,
                                        })
                                        logger.info(
                                            "TTS chunk sent: '%s' (%.0fms after first token)",
                                            tts_text[:60],
                                            (time.time() - (t_first_token or t_api)) * 1000,
                                        )
                                    except Exception:
                                        pass

            t_api_done = time.time()

            # ── TIMING: Parse response ──
            t_parse = time.time()

            # Strip markdown code blocks that Claude sometimes wraps around JSON
            cleaned = response_text.strip()
            if cleaned.startswith("```"):
                lines = cleaned.split("\n")
                lines = lines[1:]
                if lines and lines[-1].strip() == "```":
                    lines = lines[:-1]
                cleaned = "\n".join(lines).strip()

            # Parse JSON response — try multiple strategies
            parsed = None

            # Strategy 1: direct JSON parse
            try:
                parsed = json.loads(cleaned)
            except json.JSONDecodeError:
                pass

            # Strategy 2: truncated JSON — find last complete JSON object
            if parsed is None and cleaned.startswith("{"):
                for suffix in ['}', ']}', '"]}', '"}]}', '""]}']:
                    try:
                        parsed = json.loads(cleaned + suffix)
                        logger.info("Repaired truncated JSON with suffix: %s", suffix)
                        break
                    except json.JSONDecodeError:
                        continue

            if parsed and isinstance(parsed, dict):
                brain_text = parsed.get("text", ".")
                intent = parsed.get("intent", "question")
                entities = parsed.get("entities", [])
                actions = parsed.get("actions", [])
                state = parsed.get("state", "listening")
            else:
                logger.warning(
                    "Claude response was not JSON, using raw text: %s",
                    response_text[:200],
                )
                # Use Claude's actual text (truncated for voice), not a placeholder
                raw = response_text.strip()
                brain_text = raw[:200] if raw else "I didn't catch that. Try again?"
                intent = "question"
                entities = []
                actions = []
                state = "listening"

            t_parse_done = time.time()

            # ── TIMING: Fallback action detection ──
            t_fallback = time.time()
            if not actions:
                actions = _detect_actions_from_query(text)
                if actions:
                    brain_text = "."
                    logger.info("Fallback action detected: %s", actions[0]["action"])
            t_fallback_done = time.time()

            # Guard: Claude API requires non-empty content in all messages
            if not brain_text or not brain_text.strip():
                brain_text = "."

            # Update session history
            if session_id and session_id in self.sessions:
                self.sessions[session_id].append({"role": "user", "content": text})
                self.sessions[session_id].append({"role": "assistant", "content": brain_text})
                if len(self.sessions[session_id]) > 20:
                    self.sessions[session_id] = self.sessions[session_id][-20:]

            latency_ms = (time.time() - start_time) * 1000

            # ── TIMING BREAKDOWN ──
            logger.info(
                "TIMING: total=%.0fms | cache=%.0fms | build=%.0fms | "
                "api=%.0fms (first_token=%.0fms) | parse=%.0fms | fallback=%.0fms | "
                "intent=%s actions=%d",
                latency_ms,
                (t_cache_done - t_cache) * 1000,
                (t_build_done - t_build) * 1000,
                (t_api_done - t_api) * 1000,
                ((t_first_token - t_api) * 1000) if t_first_token else 0,
                (t_parse_done - t_parse) * 1000,
                (t_fallback_done - t_fallback) * 1000,
                intent,
                len(actions),
            )

            return BrainResponse(
                request_id=request_id,
                text=brain_text,
                intent=intent,
                entities=entities,
                actions=actions,
                state=state,
                latency_ms=latency_ms
            )

        except Exception as exc:
            logger.error("Brain processing error: %s", exc)
            latency_ms = (time.time() - start_time) * 1000
            return BrainResponse(
                request_id=request_id,
                text="I'm having trouble processing that right now. Could you try again?",
                intent="error",
                state="error",
                latency_ms=latency_ms
            )


# ─── Application Setup ────────────────────────────────────────────────

brain = BrainEngine()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events"""
    await brain.start()
    yield
    await brain.stop()


app = FastAPI(
    title="Razor Brain Intelligence Agent",
    description="Claude-powered sales coaching and conversation intelligence",
    version="1.0.0",
    lifespan=lifespan
)


# ─── WebSocket Endpoint ───────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocket endpoint for real-time conversation processing.

    Client sends:
        {"text": "user utterance", "metadata": {}, "stream": false, "request_id": "req_123"}

    Server responds:
        {"type": "response", "request_id": "req_123", "text": "...", "intent": "...", ...}
    """
    await websocket.accept()
    client_id = f"ws_{uuid.uuid4().hex[:8]}"
    session_id = brain.new_session()
    logger.info("WebSocket connected: %s (session=%s)", client_id, session_id)

    try:
        while True:
            # Receive message
            data = await websocket.receive_text()

            try:
                message = WebSocketMessage.model_validate_json(data)
            except Exception as e:
                logger.warning("Invalid message format: %s", e)
                await websocket.send_json({
                    "type": "error",
                    "error": "Invalid message format",
                    "details": str(e)
                })
                continue

            if not message.text.strip():
                await websocket.send_json({
                    "type": "error",
                    "request_id": message.request_id,
                    "error": "Empty text"
                })
                continue

            # Process through brain (pass websocket for streaming chunks)
            response = await brain.process(
                text=message.text,
                metadata=message.metadata,
                request_id=message.request_id,
                session_id=session_id,
                websocket=websocket if message.stream else None,
            )

            # Send response
            await websocket.send_json(response.model_dump())

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected: %s", client_id)
    except Exception as exc:
        logger.error("WebSocket error for %s: %s", client_id, exc)
        try:
            await websocket.close()
        except:
            pass


# ─── REST Endpoints ───────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse)
async def health():
    """Health check endpoint"""
    return HealthResponse(status="ok", model=MODEL_NAME)


@app.post("/session/new", response_model=SessionResponse)
async def new_session():
    """Create a new conversation session"""
    session_id = brain.new_session()
    return SessionResponse(session_id=session_id)


@app.post("/process")
async def process_http(message: WebSocketMessage):
    """
    HTTP endpoint for processing (alternative to WebSocket).
    Useful for testing and simple integrations.
    """
    response = await brain.process(
        text=message.text,
        metadata=message.metadata,
        request_id=message.request_id,
        session_id=None
    )
    return JSONResponse(content=response.model_dump())


# ─── Main ─────────────────────────────────────────────────────────────

def main():
    """Run the server"""
    import uvicorn

    logger.info("Starting Razor Brain Intelligence Agent...")
    logger.info("Model: %s", MODEL_NAME)
    logger.info("WebSocket: ws://127.0.0.1:8780/ws")
    logger.info("Health: http://127.0.0.1:8780/health")

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8780,
        log_level="info",
        access_log=True
    )


if __name__ == "__main__":
    main()
