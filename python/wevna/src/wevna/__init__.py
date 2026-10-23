"""Wevna — a local-first runtime dashboard for Python backends."""

from __future__ import annotations

from wevna import correlation
from wevna.api import (
    OpenedRecording,
    StartResult,
    is_recording,
    is_running,
    open_recording,
    start,
    start_recording,
    stop,
    stop_recording,
    url,
)
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
from wevna.recording import RecordingError, SessionLoader, SessionRecorder
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
    "OpenedRecording",
    "RecordingError",
    "Runtime",
    "Session",
    "SessionLoader",
    "SessionRecorder",
    "SessionStatus",
    "StartResult",
    "WevnaMiddleware",
    "__version__",
    "correlation",
    "default_runtime",
    "is_recording",
    "is_running",
    "new_id",
    "now_ms",
    "open_recording",
    "start",
    "start_recording",
    "stop",
    "stop_recording",
    "url",
]
