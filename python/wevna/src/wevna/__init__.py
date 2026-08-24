"""Wevna — a local-first runtime dashboard for Python backends."""

from __future__ import annotations

from wevna import correlation
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
from wevna.runtime import Runtime

__version__ = "0.1.0"

__all__ = [
    "PROTOCOL_VERSION",
    "RECORDING_FORMAT_VERSION",
    "CapturedEvent",
    "Correlation",
    "Envelope",
    "EventBus",
    "Runtime",
    "Session",
    "SessionStatus",
    "__version__",
    "correlation",
    "new_id",
    "now_ms",
]
