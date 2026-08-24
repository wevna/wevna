"""The convenience API: ``wevna.start()`` and ``wevna.stop()``.

Everything here is a thin layer over ``Runtime``, ``DashboardServer`` and the
logging handler. It exists because the promise the project is built on is one
line in somebody's startup, and a developer should not have to assemble four
objects to get it.

Deliberately synchronous. ``start()`` is called before the application's event
loop exists — often at import time, at the top of a module — so it cannot be a
coroutine. The server runs on its own thread precisely so this stays true.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from wevna.logging_capture import install as install_log_capture
from wevna.runtime import Runtime, default_runtime
from wevna.server import DashboardServer

_log = logging.getLogger("wevna.api")


@dataclass(frozen=True)
class StartResult:
    """What ``start()`` gives back.

    A value rather than nothing, because the URL is the single most useful
    thing to have in hand — for printing, for a test to connect to, and for
    the case where port 0 was requested and the real port is only known now.
    """

    url: str
    session_id: str


class _State:
    """Module-level singletons, kept in one object so reset() is total."""

    server: DashboardServer | None = None
    uninstall_log_capture: object | None = None


_state = _State()


def start(
    port: int = 4123,
    host: str = "localhost",
    *,
    capture_logging: bool = True,
    runtime: Runtime | None = None,
) -> StartResult:
    """Starts Wevna: a session, the dashboard, and log capture.

    Idempotent. Called twice — a reload, two entry points, a test fixture —
    it returns the existing session rather than starting a second server on a
    port already in use.
    """
    target = runtime if runtime is not None else default_runtime()

    if _state.server is not None:
        session = target.session
        return StartResult(
            url=_state.server.url,
            session_id=session.id if session is not None else "",
        )

    session = target.start_session()

    server = DashboardServer(host=host, port=port)
    # Subscribed before the server starts listening, so an event published
    # between the two cannot be missed.
    target.subscribe(server.broadcaster.publish)
    server.start()
    _state.server = server

    if capture_logging:
        _state.uninstall_log_capture = install_log_capture(target.publish)

    print(f"Wevna running at {server.url}")
    return StartResult(url=server.url, session_id=session.id)


def stop(*, runtime: Runtime | None = None) -> None:
    """Stops the dashboard, removes log capture, and ends the session.

    Safe to call when nothing is running, and safe to call twice — teardown
    paths run more often than once, and raising here would make a clean
    shutdown harder than a dirty one.
    """
    target = runtime if runtime is not None else default_runtime()

    uninstall = _state.uninstall_log_capture
    _state.uninstall_log_capture = None
    if callable(uninstall):
        try:
            uninstall()
        except Exception:
            _log.exception("failed to remove the logging handler")

    server = _state.server
    _state.server = None
    if server is not None:
        try:
            server.stop()
        except Exception:
            _log.exception("failed to stop the dashboard server")

    target.stop_session()


def is_running() -> bool:
    return _state.server is not None


def url() -> str | None:
    """The dashboard's URL, or None if it is not running."""
    return _state.server.url if _state.server is not None else None
