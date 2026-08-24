"""Wevna — a local-first runtime dashboard for Python backends."""

from __future__ import annotations

from wevna import correlation
from wevna.api import StartResult, is_running, start, stop, url
from wevna.asgi import WevnaMiddleware
from wevna.event_bus import EventBus
from wevna.protocol import (
    PROTOCOL_VERSION,
    RECORDING_FORMAT_VERSION,
    CapturedEvent,
    Correlation,
    Envelope,
    Session,
    SessionStatus,
    new_id,
    now_ms,
)
from wevna.runtime import Runtime, default_runtime
from wevna.server import DashboardServer

__version__ = "0.1.0"

__all__ = [
    "PROTOCOL_VERSION",
    "RECORDING_FORMAT_VERSION",
    "CapturedEvent",
    "Correlation",
    "DashboardServer",
    "Envelope",
    "EventBus",
    "Runtime",
    "Session",
    "SessionStatus",
    "StartResult",
    "WevnaMiddleware",
    "__version__",
    "correlation",
    "default_runtime",
    "is_running",
    "new_id",
    "now_ms",
    "start",
    "stop",
    "url",
]
