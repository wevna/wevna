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

import atexit
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from wevna.logging_capture import install as install_log_capture
from wevna.recording import SessionLoader, SessionMetadata, SessionRecorder
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
    recorder: SessionRecorder | None = None
    # A start_recording() made before start(): there is no session yet to
    # describe, so it waits here and begins when start() creates one.
    pending_recording: str | os.PathLike[str] | None = None
    atexit_registered: bool = False


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
    _begin_pending_recording(target)
    return StartResult(url=server.url, session_id=session.id)


def stop(*, runtime: Runtime | None = None) -> None:
    """Stops the dashboard, removes log capture, and ends the session.

    Safe to call when nothing is running, and safe to call twice — teardown
    paths run more often than once, and raising here would make a clean
    shutdown harder than a dirty one.
    """
    target = runtime if runtime is not None else default_runtime()

    # Before the session ends, so the footer follows the last event.
    _state.pending_recording = None
    stop_recording()

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


# ---------------------------------------------------------------------------
# Recording and replay
# ---------------------------------------------------------------------------


def start_recording(path: str | os.PathLike[str], *, runtime: Runtime | None = None) -> None:
    """Records the session's events to ``path`` as JSON Lines.

    The same format the Node SDK writes, so the file replays in the same
    dashboard and opens in either SDK. Opt-in: nothing is written unless this is
    called.

    Safe to call before ``wevna.start()``, as in the Node SDK. There is no
    session yet to describe, so the request is held and begins when ``start()``
    creates one (a failure to open the file at that point is logged, since there
    is no caller left to raise it to). Called while already recording it does
    nothing. Called after ``start()`` it raises ``OSError`` if the file cannot be
    opened.

    The file is appended to if it exists, as the Node recorder does.
    """
    target = runtime if runtime is not None else default_runtime()
    if not target.is_running:
        # First request wins, matching the Node queue, where every later request
        # finds a recording already in progress and is a no-op.
        if _state.pending_recording is None:
            _state.pending_recording = path
        return
    _begin_recording(target, path)


def stop_recording() -> None:
    """Writes the footer and closes the recording. Safe when not recording."""
    recorder = _state.recorder
    if recorder is not None:
        recorder.stop()


def is_recording() -> bool:
    recorder = _state.recorder
    return recorder is not None and recorder.is_recording


def _begin_recording(target: Runtime, path: str | os.PathLike[str]) -> None:
    session = target.session
    if session is None:
        return
    if _state.recorder is None:
        _state.recorder = SessionRecorder()
    _state.recorder.start(target.subscribe, session, path)
    if not _state.atexit_registered:
        # A Python app usually ends without anyone calling stop(). Without this
        # the recording would have no footer and read as having crashed.
        atexit.register(stop_recording)
        _state.atexit_registered = True


def _begin_pending_recording(target: Runtime) -> None:
    path, _state.pending_recording = _state.pending_recording, None
    if path is None:
        return
    try:
        _begin_recording(target, path)
    except OSError:
        _log.exception("could not start the recording requested before start(): %s", path)


@dataclass
class OpenedRecording:
    """A recording being replayed in the dashboard. Close it when done."""

    url: str
    path: Path
    loader: SessionLoader
    _server: DashboardServer

    @property
    def metadata(self) -> SessionMetadata:
        assert self.loader.metadata is not None
        return self.loader.metadata

    def close(self) -> None:
        self._server.stop()

    def __enter__(self) -> OpenedRecording:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def open_recording(
    path: str | os.PathLike[str], *, port: int = 4123, host: str = "localhost"
) -> OpenedRecording:
    """Serves a recording in the dashboard, with replay controls.

    Works on a recording from either SDK. Raises ``RecordingError`` (its ``type``
    is one of the Node loader's error types) if the file cannot be used.
    """
    loader = SessionLoader(path)
    loader.open()
    # Read through once so the dashboard can show the event count and end time,
    # which live in the footer. A stream over the file: nothing is held in memory.
    for _ in loader.events():
        pass

    server = DashboardServer(host=host, port=port, recording=loader)
    server.start()
    print(f"Wevna replaying {path} at {server.url}")
    return OpenedRecording(url=server.url, path=Path(path), loader=loader, _server=server)
