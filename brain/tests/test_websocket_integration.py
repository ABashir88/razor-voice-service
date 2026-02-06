"""
WebSocket Integration Test
===========================
Quick manual test to verify WebSocket protocol matches specification.

Run with: python3 brain/tests/test_websocket_integration.py
"""

import json
import asyncio
import websockets


async def test_websocket_protocol():
    """Test WebSocket sends and receives correct format"""
    uri = "ws://127.0.0.1:8780/ws"

    print("Attempting to connect to", uri)
    print("(Note: Server must be running for this test to work)")
    print()

    try:
        async with websockets.connect(uri, timeout=5) as websocket:
            print("✓ Connected to WebSocket")

            # Test message
            message = {
                "text": "Hello Razor",
                "metadata": {"source": "test"},
                "stream": False,
                "request_id": "test_req_123"
            }

            print(f"\nSending: {json.dumps(message, indent=2)}")
            await websocket.send(json.dumps(message))

            # Receive response
            response_raw = await asyncio.wait_for(websocket.recv(), timeout=10)
            response = json.loads(response_raw)

            print(f"\nReceived: {json.dumps(response, indent=2)}")

            # Verify response structure
            assert response.get("type") == "response"
            assert response.get("request_id") == "test_req_123"
            assert "text" in response
            assert "intent" in response
            assert "entities" in response
            assert "actions" in response
            assert "state" in response
            assert "latency_ms" in response

            print("\n✓ Response has correct structure")
            print(f"✓ Intent: {response['intent']}")
            print(f"✓ State: {response['state']}")
            print(f"✓ Latency: {response['latency_ms']:.0f}ms")

            await websocket.close()
            print("\n✓ WebSocket protocol test PASSED")
            return True

    except asyncio.TimeoutError:
        print("\n✗ Connection timeout - is the server running?")
        print("  Start server with: python3 -m razor_brain.server")
        return False
    except ConnectionRefusedError:
        print("\n✗ Connection refused - server is not running")
        print("  Start server with: python3 -m razor_brain.server")
        return False
    except Exception as e:
        print(f"\n✗ Test failed: {e}")
        return False


if __name__ == "__main__":
    print("=" * 70)
    print("WEBSOCKET INTEGRATION TEST")
    print("=" * 70)
    print()
    print("This test requires the brain server to be running.")
    print("To start the server:")
    print("  python3 -m razor_brain.server")
    print()
    print("Then run this test in another terminal.")
    print("=" * 70)
    print()

    result = asyncio.run(test_websocket_protocol())
    exit(0 if result else 1)
