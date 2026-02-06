"""
Razor Brain — Integration Examples
=====================================
Shows how to use the ConversationEngine from your voice pipeline,
from a WebSocket client, and from HTTP.
"""

import asyncio
import json

import websockets

from razor_brain.engine import ConversationEngine, EngineConfig
from razor_brain.gateway import GatewayConfig


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Example 1: Direct Engine Usage (embed in your voice pipeline)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def example_direct_usage():
    """
    Embed the engine directly in your Python process.
    Best for tight integration with your voice pipeline.
    """
    config = EngineConfig(
        gateway=GatewayConfig(uri="ws://127.0.0.1:18789"),
        context_window_size=20,
        auto_compress_at=30,
        response_timeout=45.0,
    )

    async with ConversationEngine(config) as engine:
        # ── Multi-turn debrief example ──────────────────────────────
        r1 = await engine.process("I just got off the phone with Marcus at Clearwater")
        print(f"Brain: {r1.text}")
        print(f"  Intent: {r1.intent}, State: {r1.state}")
        print(f"  Entities: {r1.entities}")
        print(f"  Follow-up: {r1.follow_up}")
        print()

        r2 = await engine.process("He wants to push the deal to Q3")
        print(f"Brain: {r2.text}")
        # The brain resolves "He" → Marcus, "the deal" → Clearwater deal
        print()

        r3 = await engine.process("Yeah set a reminder for that")
        print(f"Brain: {r3.text}")
        # "that" → pushing the deal to Q3
        print()

        # ── Implicit reference example ──────────────────────────────
        r4 = await engine.process("Actually call him back")
        print(f"Brain: {r4.text}")
        # "him" → Marcus (most recently referenced person)
        print()

        # ── Clarification example ───────────────────────────────────
        r5 = await engine.process("What about the Clearfield thing")
        print(f"Brain: {r5.text}")
        # Brain might say: "I heard Clearfield — did you mean the Clearwater
        # deal with Marcus, or is Clearfield something separate?"
        print()

        # ── Check engine status ─────────────────────────────────────
        status = engine.status()
        print(f"Session: {status['session']['session_id']}")
        print(f"Turns: {status['session']['turn_count']}")
        print(f"State: {status['state']['current_state']}")
        print(f"Gateway latency: {status['gateway']['avg_latency_ms']}ms")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Example 2: WebSocket Client (connect to the Razor Brain server)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def example_websocket_client():
    """
    Connect to a running Razor Brain server over WebSocket.
    This is how the voice pipeline talks to the brain when running
    as a separate process.
    """
    uri = "ws://localhost:8780/ws"

    async with websockets.connect(uri) as ws:
        # Send a structured message
        await ws.send(json.dumps({
            "text": "Schedule a meeting with the Clearwater team next Tuesday",
            "metadata": {
                "source": "voice_pipeline",
                "audio_confidence": 0.94,
            },
            "stream": False,
        }))

        # Receive the response
        raw = await ws.recv()
        response = json.loads(raw)

        print(f"Brain: {response['text']}")
        print(f"Intent: {response.get('intent')}")
        print(f"Actions: {response.get('actions', [])}")

        # Or send plain text (also works)
        await ws.send("What about Thursday instead")
        raw = await ws.recv()
        response = json.loads(raw)
        print(f"Brain: {response['text']}")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Example 3: Streaming Response
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def example_streaming():
    """
    Stream brain responses for lower perceived latency.
    Great for TTS pipelines that can start speaking mid-response.
    """
    config = EngineConfig(
        gateway=GatewayConfig(uri="ws://127.0.0.1:18789"),
    )

    async with ConversationEngine(config) as engine:
        chunks = []

        def on_chunk(chunk: str):
            chunks.append(chunk)
            # Feed directly to your TTS engine here
            print(f"[STREAM] {chunk}", end="", flush=True)

        response = await engine.process(
            "Give me a summary of all my calls today",
            stream_callback=on_chunk,
        )
        print()  # newline after streaming
        print(f"[COMPLETE] Full response: {response.text}")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Example 4: Action Callbacks (react to brain-suggested actions)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def example_with_callbacks():
    """
    Register callbacks so your pipeline reacts to brain-inferred actions.
    The brain might say "call Marcus" — the on_action callback fires
    so your telephony module can initiate the call.
    """
    def handle_response(response):
        # Feed response.text to TTS
        print(f"[TTS] Speaking: {response.text}")

    def handle_action(action):
        # Dispatch to appropriate Razor module
        action_type = action.get("action")
        params = action.get("params", {})
        print(f"[ACTION] {action_type}: {params}")

        # Example dispatching
        if action_type == "initiate_call":
            # telephony.call(params["phone_number"])
            pass
        elif action_type == "send_message":
            # messaging.send(params["to"], params["body"])
            pass
        elif action_type == "create_reminder":
            # calendar.remind(params["text"], params["when"])
            pass

    def handle_error(exc):
        print(f"[ERROR] {exc}")

    config = EngineConfig(
        on_response=handle_response,
        on_action=handle_action,
        on_error=handle_error,
    )

    async with ConversationEngine(config) as engine:
        await engine.process("Call Marcus back and tell him we agree to Q3")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if __name__ == "__main__":
    print("=" * 60)
    print("Razor Brain — Integration Examples")
    print("=" * 60)
    print()
    print("Run one of:")
    print("  asyncio.run(example_direct_usage())")
    print("  asyncio.run(example_websocket_client())")
    print("  asyncio.run(example_streaming())")
    print("  asyncio.run(example_with_callbacks())")
    print()
    print("Or start the server:")
    print("  razor-brain --gateway-uri ws://127.0.0.1:18789")
