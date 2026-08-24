"""Wevna — a local-first runtime dashboard for Python backends."""

from __future__ import annotations

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

__version__ = "0.1.0"

__all__ = [
    "PROTOCOL_VERSION",
    "RECORDING_FORMAT_VERSION",
    "CapturedEvent",
    "Correlation",
    "Envelope",
    "Session",
    "SessionStatus",
    "__version__",
    "new_id",
    "now_ms",
]
