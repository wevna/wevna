"""Wevna for Python: see what your backend is actually doing.

    import wevna
    wevna.start()                       # sends events to the local dashboard

    app = wevna.asgi.WevnaMiddleware(app)          # FastAPI, Starlette, ...
    app.wsgi_app = wevna.wsgi.WevnaWSGIMiddleware(app.wsgi_app)   # Flask, ...

The dashboard itself is the Node one: run `npx @wevna/sdk` and open
http://localhost:4123.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from . import _client, asgi, instrumentation, wsgi
from ._context import bind_context, current_correlation_id, request_scope, set_route
from ._patching import unpatch_all
from .instrumentation import instrument_connection, instrument_sqlalchemy

__version__ = "0.1.0"

__all__ = [
    "__version__",
    "asgi",
    "bind_context",
    "current_correlation_id",
    "emit",
    "instrument_connection",
    "instrument_sqlalchemy",
    "request_scope",
    "set_route",
    "start",
    "stop",
    "wsgi",
]

emit = _client.emit


def start(url: Optional[str] = None, *, instrument: bool = True, **client_options: Any) -> None:
    """Begin sending events to the dashboard.

    `url` defaults to $WEVNA_URL, then http://localhost:4123. With
    `instrument=True` (the default) the libraries that are installed —
    requests, httpx, redis — are instrumented and `logging` is captured;
    anything not installed is skipped silently. SQL needs an explicit
    `instrument_connection()` because DB-API connections cannot be patched.

    Safe to call when the dashboard is not running: delivery fails quietly.
    """
    _client.start_client(url or os.environ.get("WEVNA_URL"), **client_options)
    if instrument:
        instrumentation.instrument_logging()
        instrumentation.instrument_requests()
        instrumentation.instrument_httpx()
        instrumentation.instrument_redis()


def stop() -> None:
    """Flush what is queued, undo every patch, and stop sending."""
    instrumentation.uninstrument_logging()
    unpatch_all()
    _client.stop_client()
