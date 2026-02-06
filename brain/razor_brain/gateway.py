"""
OpenClaw Gateway Client
========================
WebSocket client for the OpenClaw AI brain at ws://127.0.0.1:18789.
Handles connection lifecycle, reconnection, message framing, and health.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional

import websockets
import websockets.exceptions

logger = logging.getLogger("razor.gateway")


class GatewayStatus(str, Enum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    RECONNECTING = "reconnecting"
    FATAL = "fatal"


@dataclass
class GatewayConfig:
    """Configuration for the OpenClaw gateway connection."""

    uri: str = "ws://127.0.0.1:18789"
    reconnect_delay_base: float = 1.0        # base seconds between retries
    reconnect_delay_max: float = 30.0         # max backoff
    reconnect_max_attempts: int = 50          # 0 = infinite
    ping_interval: float = 20.0               # WebSocket ping interval
    ping_timeout: float = 10.0                # ping response timeout
    response_timeout: float = 60.0            # max wait for brain response
    max_message_size: int = 10 * 1024 * 1024  # 10 MB
    connect_timeout: float = 10.0


@dataclass
class PendingRequest:
    """A message awaiting a response from the brain."""

    request_id: str
    payload: dict[str, Any]
    future: asyncio.Future
    sent_at: float = field(default_factory=time.time)
    timeout: float = 60.0


class OpenClawGateway:
    """
    Manages the WebSocket connection to the OpenClaw AI brain.

    All conversation intelligence flows through this single connection.
    Supports request/response correlation, streaming, and health monitoring.
    """

    def __init__(self, config: Optional[GatewayConfig] = None) -> None:
        self.config = config or GatewayConfig()
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._status = GatewayStatus.DISCONNECTED
        self._reconnect_attempt = 0
        self._pending: dict[str, PendingRequest] = {}
        self._stream_callbacks: dict[str, Callable] = {}
        self._status_listeners: list[Callable] = []

        # Health metrics
        self._messages_sent = 0
        self._messages_received = 0
        self._last_send_at: Optional[float] = None
        self._last_recv_at: Optional[float] = None
        self._total_latency = 0.0
        self._latency_samples = 0

        # Background tasks
        self._reader_task: Optional[asyncio.Task] = None
        self._health_task: Optional[asyncio.Task] = None

    # ─── Connection Lifecycle ─────────────────────────────────────────

    async def connect(self) -> None:
        """Establish WebSocket connection to the OpenClaw gateway."""
        if self._status == GatewayStatus.CONNECTED:
            return

        self._set_status(GatewayStatus.CONNECTING)

        try:
            self._ws = await asyncio.wait_for(
                websockets.connect(
                    self.config.uri,
                    ping_interval=self.config.ping_interval,
                    ping_timeout=self.config.ping_timeout,
                    max_size=self.config.max_message_size,
                    close_timeout=5.0,
                ),
                timeout=self.config.connect_timeout,
            )
            self._set_status(GatewayStatus.CONNECTED)
            self._reconnect_attempt = 0
            logger.info("Connected to OpenClaw gateway at %s", self.config.uri)

            # Start background reader
            self._reader_task = asyncio.create_task(self._read_loop())
            self._health_task = asyncio.create_task(self._health_loop())

        except (
            OSError,
            websockets.exceptions.WebSocketException,
            asyncio.TimeoutError,
        ) as exc:
            logger.error("Failed to connect to OpenClaw gateway: %s", exc)
            self._set_status(GatewayStatus.DISCONNECTED)
            raise ConnectionError(
                f"Cannot reach OpenClaw gateway at {self.config.uri}: {exc}"
            ) from exc

    async def disconnect(self) -> None:
        """Gracefully close the gateway connection."""
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
        if self._health_task and not self._health_task.done():
            self._health_task.cancel()

        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass

        # Fail all pending requests
        for req in self._pending.values():
            if not req.future.done():
                req.future.set_exception(
                    ConnectionError("Gateway disconnected")
                )
        self._pending.clear()

        self._ws = None
        self._set_status(GatewayStatus.DISCONNECTED)
        logger.info("Disconnected from OpenClaw gateway")

    async def _reconnect(self) -> None:
        """Attempt to reconnect with exponential backoff."""
        self._set_status(GatewayStatus.RECONNECTING)

        while True:
            self._reconnect_attempt += 1

            if (
                self.config.reconnect_max_attempts > 0
                and self._reconnect_attempt > self.config.reconnect_max_attempts
            ):
                self._set_status(GatewayStatus.FATAL)
                logger.critical(
                    "Max reconnection attempts (%d) exhausted",
                    self.config.reconnect_max_attempts,
                )
                # Fail all pending
                for req in self._pending.values():
                    if not req.future.done():
                        req.future.set_exception(
                            ConnectionError("Gateway reconnection failed")
                        )
                self._pending.clear()
                return

            delay = min(
                self.config.reconnect_delay_base * (2 ** (self._reconnect_attempt - 1)),
                self.config.reconnect_delay_max,
            )
            logger.info(
                "Reconnect attempt %d in %.1fs...",
                self._reconnect_attempt,
                delay,
            )
            await asyncio.sleep(delay)

            try:
                await self.connect()
                logger.info("Reconnected successfully on attempt %d", self._reconnect_attempt)

                # Re-send any pending requests that haven't timed out
                now = time.time()
                for req in list(self._pending.values()):
                    if now - req.sent_at < req.timeout and not req.future.done():
                        await self._raw_send(req.payload)

                return
            except ConnectionError:
                continue

    # ─── Message Send / Receive ───────────────────────────────────────

    async def send(
        self,
        payload: dict[str, Any],
        timeout: Optional[float] = None,
        stream_callback: Optional[Callable[[str], None]] = None,
    ) -> dict[str, Any]:
        """
        Send a message to the brain and await the response.

        Args:
            payload: The full message payload (context + user turn).
            timeout: Override response timeout.
            stream_callback: If provided, called with each streaming chunk.

        Returns:
            The brain's response as a parsed dict.

        Raises:
            ConnectionError: If not connected and reconnection fails.
            TimeoutError: If brain doesn't respond in time.
        """
        if self._status != GatewayStatus.CONNECTED:
            await self.connect()

        request_id = str(uuid.uuid4())
        timeout = timeout or self.config.response_timeout

        message = {
            "request_id": request_id,
            "type": "conversation",
            **payload,
        }

        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()

        pending = PendingRequest(
            request_id=request_id,
            payload=message,
            future=future,
            timeout=timeout,
        )
        self._pending[request_id] = pending

        if stream_callback:
            self._stream_callbacks[request_id] = stream_callback

        try:
            await self._raw_send(message)
            result = await asyncio.wait_for(future, timeout=timeout)
            return result
        except asyncio.TimeoutError:
            logger.warning("Brain response timed out for request %s", request_id)
            raise TimeoutError(
                f"Brain did not respond within {timeout}s"
            )
        finally:
            self._pending.pop(request_id, None)
            self._stream_callbacks.pop(request_id, None)

    async def _raw_send(self, message: dict[str, Any]) -> None:
        """Send a raw JSON message over the WebSocket."""
        if not self._ws:
            raise ConnectionError("WebSocket not connected")

        data = json.dumps(message, default=str)
        try:
            await self._ws.send(data)
            self._messages_sent += 1
            self._last_send_at = time.time()
        except websockets.exceptions.ConnectionClosed:
            logger.warning("Connection lost during send, initiating reconnect")
            asyncio.create_task(self._reconnect())
            raise ConnectionError("Connection lost during send")

    async def _read_loop(self) -> None:
        """Background task that reads all messages from the gateway."""
        try:
            async for raw in self._ws:
                self._messages_received += 1
                self._last_recv_at = time.time()

                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("Received non-JSON from gateway: %s", raw[:200])
                    continue

                await self._dispatch(message)

        except websockets.exceptions.ConnectionClosed as exc:
            logger.warning("Gateway connection closed: %s", exc)
            if self._status != GatewayStatus.DISCONNECTED:
                asyncio.create_task(self._reconnect())
        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.exception("Unexpected error in gateway reader: %s", exc)
            if self._status != GatewayStatus.DISCONNECTED:
                asyncio.create_task(self._reconnect())

    async def _dispatch(self, message: dict[str, Any]) -> None:
        """Route an incoming gateway message to the correct handler."""
        request_id = message.get("request_id")
        msg_type = message.get("type", "response")

        if msg_type == "stream_chunk" and request_id in self._stream_callbacks:
            chunk = message.get("content", "")
            try:
                self._stream_callbacks[request_id](chunk)
            except Exception:
                pass
            return

        if msg_type == "stream_end":
            # Stream finished — resolve with the accumulated response
            # The final payload contains the full response
            pass  # Fall through to resolve the future

        if request_id and request_id in self._pending:
            pending = self._pending[request_id]
            if not pending.future.done():
                # Track latency
                latency = time.time() - pending.sent_at
                self._total_latency += latency
                self._latency_samples += 1

                if message.get("error"):
                    pending.future.set_exception(
                        RuntimeError(
                            f"Brain error: {message['error']}"
                        )
                    )
                else:
                    pending.future.set_result(message)
        else:
            # Unsolicited message (could be a push notification from brain)
            logger.debug("Unsolicited gateway message: %s", msg_type)

    # ─── Health Monitoring ────────────────────────────────────────────

    async def _health_loop(self) -> None:
        """Periodic health check."""
        try:
            while True:
                await asyncio.sleep(30)
                if self._ws and self._status == GatewayStatus.CONNECTED:
                    try:
                        pong = await self._ws.ping()
                        await asyncio.wait_for(pong, timeout=5.0)
                    except (asyncio.TimeoutError, Exception):
                        logger.warning("Health ping failed, reconnecting")
                        asyncio.create_task(self._reconnect())
                        return
        except asyncio.CancelledError:
            return

    # ─── Status ───────────────────────────────────────────────────────

    def _set_status(self, status: GatewayStatus) -> None:
        old = self._status
        self._status = status
        if old != status:
            logger.info("Gateway status: %s → %s", old.value, status.value)
            for listener in self._status_listeners:
                try:
                    listener(old, status)
                except Exception:
                    pass

    def on_status_change(self, callback: Callable) -> None:
        self._status_listeners.append(callback)

    @property
    def status(self) -> GatewayStatus:
        return self._status

    @property
    def is_connected(self) -> bool:
        return self._status == GatewayStatus.CONNECTED

    @property
    def avg_latency(self) -> float:
        if self._latency_samples == 0:
            return 0.0
        return self._total_latency / self._latency_samples

    def health_report(self) -> dict[str, Any]:
        return {
            "status": self._status.value,
            "uri": self.config.uri,
            "messages_sent": self._messages_sent,
            "messages_received": self._messages_received,
            "pending_requests": len(self._pending),
            "avg_latency_ms": round(self.avg_latency * 1000, 2),
            "reconnect_attempts": self._reconnect_attempt,
            "last_send": self._last_send_at,
            "last_recv": self._last_recv_at,
        }
