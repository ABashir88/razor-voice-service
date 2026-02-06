"""
Brain Server Tests
==================
Tests for the Razor Brain Intelligence Agent (FastAPI + Claude API).

Run with: python brain/tests/test_server.py
Or with pytest: pytest brain/tests/test_server.py -v
"""

import asyncio
import json
import os
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

# Mock the ANTHROPIC_API_KEY for testing
os.environ["ANTHROPIC_API_KEY"] = "test_key_12345"

import pytest
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, MagicMock, patch

from razor_brain.server import (
    app,
    brain,
    BrainEngine,
    BrainResponse,
    HealthResponse,
    SessionResponse,
    WebSocketMessage,
    MODEL_NAME
)


# ─── Fixtures ─────────────────────────────────────────────────────────

@pytest.fixture
def client():
    """FastAPI test client"""
    return TestClient(app)


@pytest.fixture
def mock_anthropic():
    """Mock Anthropic client"""
    with patch("razor_brain.server.AsyncAnthropic") as mock:
        mock_client = AsyncMock()
        mock.return_value = mock_client
        yield mock_client


# ─── Health Endpoint Tests ────────────────────────────────────────────

def test_health_endpoint(client):
    """Test GET /health returns correct status and model"""
    response = client.get("/health")

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["model"] == MODEL_NAME
    print("  ✓ Health endpoint returns correct status and model")


# ─── Session Endpoint Tests ───────────────────────────────────────────

def test_session_new(client):
    """Test POST /session/new creates new session"""
    response = client.post("/session/new")

    assert response.status_code == 200
    data = response.json()
    assert "session_id" in data
    assert data["session_id"].startswith("session_")
    print("  ✓ Session creation returns valid session_id")


def test_session_new_unique(client):
    """Test that multiple session creations return unique IDs"""
    response1 = client.post("/session/new")
    response2 = client.post("/session/new")

    session1 = response1.json()["session_id"]
    session2 = response2.json()["session_id"]

    assert session1 != session2
    print("  ✓ Multiple session creations return unique IDs")


# ─── BrainEngine Tests ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_brain_engine_initialization():
    """Test BrainEngine initializes correctly"""
    engine = BrainEngine()

    assert engine.client is None
    assert engine.sessions == {}
    print("  ✓ BrainEngine initializes with correct defaults")


@pytest.mark.asyncio
async def test_brain_engine_new_session():
    """Test BrainEngine creates sessions correctly"""
    engine = BrainEngine()

    session_id = engine.new_session()

    assert session_id.startswith("session_")
    assert session_id in engine.sessions
    assert engine.sessions[session_id] == []
    print("  ✓ BrainEngine creates sessions correctly")


@pytest.mark.asyncio
async def test_brain_engine_process_without_api_key(mock_anthropic):
    """Test BrainEngine handles missing API key gracefully"""
    engine = BrainEngine()
    # Don't call start() to simulate missing API key

    response = await engine.process(
        text="Hello",
        metadata={},
        request_id="test_req_1"
    )

    assert response.request_id == "test_req_1"
    assert "not initialized" in response.text.lower()
    assert response.intent == "error"
    assert response.state == "error"
    print("  ✓ BrainEngine handles missing API key gracefully")


@pytest.mark.asyncio
async def test_brain_engine_process_with_mock_claude(mock_anthropic):
    """Test BrainEngine processes messages with mocked Claude API"""
    # Setup mock response
    mock_response = MagicMock()
    mock_content = MagicMock()
    mock_content.text = json.dumps({
        "text": "Hello! How can I help you today?",
        "intent": "greeting",
        "entities": [],
        "actions": [],
        "state": "listening",
        "confidence": 0.95
    })
    mock_response.content = [mock_content]
    mock_anthropic.messages.create = AsyncMock(return_value=mock_response)

    engine = BrainEngine()
    await engine.start()
    session_id = engine.new_session()

    response = await engine.process(
        text="Hello Razor",
        metadata={},
        request_id="test_req_2",
        session_id=session_id
    )

    assert response.request_id == "test_req_2"
    assert response.text == "Hello! How can I help you today?"
    assert response.intent == "greeting"
    assert response.state == "listening"
    assert response.latency_ms > 0
    print("  ✓ BrainEngine processes messages with mocked Claude API")


@pytest.mark.asyncio
async def test_brain_engine_handles_non_json_response(mock_anthropic):
    """Test BrainEngine handles non-JSON Claude responses"""
    # Setup mock response with plain text
    mock_response = MagicMock()
    mock_content = MagicMock()
    mock_content.text = "Sorry, I couldn't parse that."
    mock_response.content = [mock_content]
    mock_anthropic.messages.create = AsyncMock(return_value=mock_response)

    engine = BrainEngine()
    await engine.start()

    response = await engine.process(
        text="Some unclear input",
        metadata={},
        request_id="test_req_3"
    )

    assert response.request_id == "test_req_3"
    assert response.text == "Sorry, I couldn't parse that."
    assert response.intent == "question"  # Default fallback
    print("  ✓ BrainEngine handles non-JSON responses gracefully")


@pytest.mark.asyncio
async def test_brain_engine_handles_api_errors(mock_anthropic):
    """Test BrainEngine handles Claude API errors gracefully"""
    # Setup mock to raise exception
    mock_anthropic.messages.create = AsyncMock(
        side_effect=Exception("API connection failed")
    )

    engine = BrainEngine()
    await engine.start()

    response = await engine.process(
        text="Test error handling",
        metadata={},
        request_id="test_req_4"
    )

    assert response.request_id == "test_req_4"
    assert response.intent == "error"
    assert response.state == "error"
    assert "trouble processing" in response.text.lower()
    print("  ✓ BrainEngine handles API errors gracefully")


@pytest.mark.asyncio
async def test_brain_engine_maintains_conversation_history(mock_anthropic):
    """Test BrainEngine maintains conversation history across turns"""
    # Setup mock response
    mock_response = MagicMock()
    mock_content = MagicMock()
    mock_content.text = json.dumps({
        "text": "Response",
        "intent": "question",
        "entities": [],
        "actions": [],
        "state": "listening"
    })
    mock_response.content = [mock_content]
    mock_anthropic.messages.create = AsyncMock(return_value=mock_response)

    engine = BrainEngine()
    await engine.start()
    session_id = engine.new_session()

    # Send two messages
    await engine.process("First message", {}, "req_1", session_id)
    await engine.process("Second message", {}, "req_2", session_id)

    # Check history was maintained
    assert len(engine.sessions[session_id]) == 4  # 2 user + 2 assistant
    assert engine.sessions[session_id][0]["role"] == "user"
    assert engine.sessions[session_id][0]["content"] == "First message"
    assert engine.sessions[session_id][1]["role"] == "assistant"
    print("  ✓ BrainEngine maintains conversation history")


# ─── WebSocket Message Model Tests ────────────────────────────────────

def test_websocket_message_validation():
    """Test WebSocketMessage model validation"""
    # Valid message
    msg = WebSocketMessage(text="Hello", metadata={"source": "test"})
    assert msg.text == "Hello"
    assert msg.metadata == {"source": "test"}
    assert msg.stream is False
    assert msg.request_id.startswith("req_")
    print("  ✓ WebSocketMessage validates correctly")


def test_websocket_message_defaults():
    """Test WebSocketMessage default values"""
    msg = WebSocketMessage(text="Test")
    assert msg.metadata == {}
    assert msg.stream is False
    assert msg.request_id.startswith("req_")
    print("  ✓ WebSocketMessage has correct defaults")


# ─── BrainResponse Model Tests ────────────────────────────────────────

def test_brain_response_creation():
    """Test BrainResponse model creation"""
    response = BrainResponse(
        request_id="test_123",
        text="Response text",
        intent="greeting",
        entities=[{"name": "John", "type": "person"}],
        actions=[{"action": "log_call", "params": {}}],
        state="listening",
        latency_ms=150.5
    )

    assert response.type == "response"
    assert response.request_id == "test_123"
    assert response.text == "Response text"
    assert response.intent == "greeting"
    assert len(response.entities) == 1
    assert len(response.actions) == 1
    assert response.state == "listening"
    assert response.latency_ms == 150.5
    print("  ✓ BrainResponse creates correctly")


def test_brain_response_serialization():
    """Test BrainResponse serializes to JSON correctly"""
    response = BrainResponse(
        request_id="test_456",
        text="Test",
        intent="question"
    )

    data = response.model_dump()

    assert data["type"] == "response"
    assert data["request_id"] == "test_456"
    assert data["text"] == "Test"
    assert data["intent"] == "question"
    assert data["entities"] == []
    assert data["actions"] == []
    print("  ✓ BrainResponse serializes correctly")


# ─── Integration Tests ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_process_endpoint(mock_anthropic):
    """Test POST /process endpoint"""
    # Setup mock
    mock_response = MagicMock()
    mock_content = MagicMock()
    mock_content.text = json.dumps({
        "text": "Processed response",
        "intent": "question",
        "entities": [],
        "actions": [],
        "state": "listening"
    })
    mock_response.content = [mock_content]
    mock_anthropic.messages.create = AsyncMock(return_value=mock_response)

    # Manually start the brain engine for this test
    await brain.start()

    # Use async client for testing
    from httpx import AsyncClient
    async with AsyncClient(
        transport=None, base_url="http://test"
    ) as ac:
        ac.app = app  # Attach the FastAPI app

        # Use TestClient for synchronous testing
        from fastapi.testclient import TestClient
        client = TestClient(app)

        response = client.post(
            "/process",
            json={
                "text": "Test input",
                "metadata": {"source": "test"},
                "stream": False
            }
        )

    assert response.status_code == 200
    data = response.json()
    assert data["type"] == "response"
    assert "request_id" in data
    assert data["text"] == "Processed response"
    print("  ✓ POST /process endpoint works correctly")


# ─── Run Tests ────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("\n" + "=" * 70)
    print("RAZOR BRAIN SERVER TESTS")
    print("=" * 70 + "\n")

    # Run with pytest if available, otherwise basic tests
    try:
        import pytest

        # Run pytest
        exit_code = pytest.main([
            __file__,
            "-v",
            "--tb=short",
            "--asyncio-mode=auto"
        ])

        sys.exit(exit_code)

    except ImportError:
        print("pytest not installed. Run: pip install pytest pytest-asyncio")
        print("\nRunning basic non-async tests only:\n")

        passed = 0
        failed = 0

        # Create a client for basic tests
        client = TestClient(app)

        # Run basic tests
        tests = [
            ("Health endpoint", lambda: test_health_endpoint(client)),
            ("Session creation", lambda: test_session_new(client)),
            ("Session uniqueness", lambda: test_session_new_unique(client)),
            ("WebSocket message validation", test_websocket_message_validation),
            ("WebSocket message defaults", test_websocket_message_defaults),
            ("BrainResponse creation", test_brain_response_creation),
            ("BrainResponse serialization", test_brain_response_serialization),
        ]

        for name, test_fn in tests:
            try:
                test_fn()
                passed += 1
            except AssertionError as e:
                print(f"  ✗ {name} FAILED: {e}")
                failed += 1
            except Exception as e:
                print(f"  ✗ {name} ERROR: {e}")
                failed += 1

        print(f"\n{'=' * 70}")
        print(f"Results: {passed} passed, {failed} failed")
        print("=" * 70)

        sys.exit(1 if failed > 0 else 0)
