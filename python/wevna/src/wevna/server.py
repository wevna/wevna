"""Serves the dashboard and streams events to it.

The dashboard is the same React bundle the Node SDK ships — copied into this
package at build time rather than reimplemented, which is the entire reason the
protocol was made language-neutral first. A Python session and a Node session
are the same thing to the UI.

The server runs on its own thread with its own event loop. It has to: the
application being observed owns the main loop, and Wevna must not require the
application to hand it over, start it earlier, or await anything. That
threading boundary is the only genuinely delicate part of this module, and
``_Broadcaster`` exists solely to cross it safely.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import threading
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import uvicorn
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from wevna.host_guard import HostGuardMiddleware, allowed_hosts_for
from wevna.protocol import Envelope, dumps_wire
from wevna.recording import SessionLoader

_log = logging.getLogger("wevna.server")

DASHBOARD_DIR = Path(__file__).parent / "dashboard"


class _Broadcaster:
    """Moves envelopes from the application's thread to the server's loop.

    ``publish`` is called from wherever the application happens to be running;
    the websockets live on the server thread's loop. ``call_soon_threadsafe``
    is the only safe way across that line, and everything downstream of it is
    ordinary single-threaded asyncio.
    """

    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue[str] | None = None
        # The process that owns the loop. Compared on every publish: a forked
        # child inherits this object and a copy of the loop, but not the thread
        # that runs it.
        self._owner_pid: int | None = None
        self._warned_forked = False

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._owner_pid = os.getpid()
        self._loop = loop
        self._queue = asyncio.Queue(maxsize=10_000)

    def publish(self, envelope: Envelope) -> None:
        """Queues an envelope for delivery. Never raises, never blocks.

        Called on the application's own call stack, so the same reasoning as
        everywhere else applies: a full queue or a stopped server means a
        dropped event and a diagnostic, not an exception in a request handler.
        """
        loop, queue = self._loop, self._queue
        if loop is None or queue is None or loop.is_closed():
            return

        if self._owner_pid is not None and os.getpid() != self._owner_pid:
            # A forked worker (gunicorn, uvicorn --workers). The thread that
            # drains this loop did not survive the fork, so scheduling onto it
            # would grow a deque nobody empties — about 180 MB per 200k events —
            # while delivering nothing. Drop, and say why once.
            if not self._warned_forked:
                self._warned_forked = True
                _log.warning(
                    "this process was forked after wevna.start(), so its events are not "
                    "captured: the dashboard runs in the process that called start(). "
                    "Run a single worker while developing (for example, one uvicorn "
                    "process without --workers)."
                )
            return

        try:
            message = dumps_wire(envelope.to_wire())
        except (TypeError, ValueError):
            # A producer handed us something JSON cannot represent. Dropping
            # the one event with a diagnostic is the correct degradation — the
            # Node SDK had to learn this the hard way, where an unserializable
            # value threw out through the developer's own call site.
            _log.exception("dropped a %r event that could not be serialized", envelope.payload.kind)
            return

        try:
            loop.call_soon_threadsafe(self._enqueue, message)
        except RuntimeError:
            # The loop shut down between the check above and here.
            return

    def _enqueue(self, message: str) -> None:
        queue = self._queue
        if queue is None:
            return
        try:
            queue.put_nowait(message)
        except asyncio.QueueFull:
            # Bounded on purpose. An unbounded queue in front of a dashboard
            # nobody has opened is a memory leak that looks like a working
            # tool right up until the process dies.
            _log.warning("event queue is full; dropping an event")

    async def run(self) -> None:
        """Drains the queue to every connected client, forever."""
        queue = self._queue
        if queue is None:  # pragma: no cover - bind() always precedes run()
            return
        while True:
            message = await queue.get()
            for client in list(self._clients):
                try:
                    await client.send_text(message)
                except Exception:
                    # A client that went away mid-send. Discarding it here is
                    # cheaper and more reliable than trying to detect a
                    # half-open socket.
                    self._clients.discard(client)

    def add(self, client: WebSocket) -> None:
        self._clients.add(client)

    def remove(self, client: WebSocket) -> None:
        self._clients.discard(client)

    @property
    def client_count(self) -> int:
        return len(self._clients)


def build_app(
    broadcaster: _Broadcaster,
    allowed_hosts: tuple[str, ...] | None = None,
    recording: SessionLoader | None = None,
) -> Starlette:
    """The dashboard's own ASGI app — unrelated to the application being watched.

    With ``recording`` the dashboard is served against a file instead of a live
    session: ``/api/session`` says so, ``/api/session/events`` serves the file,
    and there is no WebSocket, because a recording is finite and already known.
    """

    async def health(_request: Any) -> JSONResponse:
        # Deliberately identical to the Node SDK's response. Anything checking
        # whether Wevna is up should not have to know which language it is.
        return JSONResponse({"status": "running", "product": "wevna"})

    async def session_info(_request: Any) -> JSONResponse:
        # The one thing the dashboard asks before it knows which event source to
        # use. Identical to the Node server's response.
        if recording is not None and recording.metadata is not None:
            return JSONResponse({"mode": "recording", "metadata": recording.metadata.to_wire()})
        return JSONResponse({"mode": "live"})

    def session_events(_request: Any) -> StreamingResponse:
        assert recording is not None

        def stream() -> Iterator[str]:
            # A fresh loader per request: loading is a stream over the file, so
            # a recording of any size is never held in memory, and the response
            # is still one JSON document, {"events": [...]}, as the Node server's is.
            loader = SessionLoader(recording.path)
            loader.open()
            yield '{"events":['
            first = True
            for recorded in loader.events():
                yield ("" if first else ",") + dumps_wire(recorded.envelope.to_wire())
                first = False
            yield "]}"

        return StreamingResponse(stream(), media_type="application/json")

    async def websocket_endpoint(websocket: WebSocket) -> None:
        await websocket.accept()
        broadcaster.add(websocket)
        try:
            while True:
                # The dashboard never sends anything; this only parks the
                # coroutine so the disconnect is observed.
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        except Exception:
            _log.debug("websocket closed unexpectedly", exc_info=True)
        finally:
            broadcaster.remove(websocket)

    routes: list[Route | WebSocketRoute | Mount] = [
        Route("/health", health),
        Route("/api/session", session_info),
    ]
    if recording is not None:
        routes.append(Route("/api/session/events", session_events))
    else:
        routes.append(WebSocketRoute("/ws", websocket_endpoint))

    if DASHBOARD_DIR.is_dir():
        routes.append(Mount("/", app=StaticFiles(directory=DASHBOARD_DIR, html=True)))
    else:
        # A wheel built without the dashboard assets. Warn loudly rather than
        # serving a blank page: the Node SDK had exactly this failure mode and
        # its warning went to a disabled logger, so nobody ever saw it.
        _log.warning(
            "dashboard assets not found at %s — the API will work but there is no UI. "
            "This usually means the package was built without running the dashboard build.",
            DASHBOARD_DIR,
        )

    @contextlib.asynccontextmanager
    async def lifespan(_app: Starlette) -> AsyncIterator[None]:
        # The broadcaster can only learn its loop from inside the running one,
        # which is why binding happens here rather than in __init__.
        broadcaster.bind(asyncio.get_running_loop())
        task = asyncio.create_task(broadcaster.run())
        try:
            yield
        finally:
            # Cancelled explicitly so a stopped server leaves nothing pending —
            # otherwise repeated start/stop cycles in a test suite accumulate
            # orphaned tasks and the failures surface somewhere unrelated.
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    # Outermost, so it sees every route including the WebSocket upgrade. Without
    # it any web page the developer visits could connect to /ws and read the
    # whole event stream — see host_guard.py.
    return Starlette(
        routes=routes,
        lifespan=lifespan,
        middleware=[
            Middleware(
                HostGuardMiddleware,
                allowed_hosts=allowed_hosts or allowed_hosts_for("localhost"),
            )
        ],
    )


class DashboardServer:
    """Runs the dashboard on a background thread."""

    def __init__(
        self,
        host: str = "localhost",
        port: int = 4123,
        recording: SessionLoader | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self._recording = recording
        self._broadcaster = _Broadcaster()
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        # The bound host, not the requested one: printing http://0.0.0.0:4123
        # gives the developer a URL their browser cannot open.
        host = "localhost" if self.host in {"0.0.0.0", "::", ""} else self.host
        return f"http://{host}:{self.port}"

    @property
    def broadcaster(self) -> _Broadcaster:
        return self._broadcaster

    def start(self, timeout: float = 5.0) -> None:
        """Starts the server and waits until it is actually listening.

        Waiting matters: ``start()`` returning before the port is open would
        make the very first thing a developer does — open the URL it just
        printed — a race.
        """
        if self._thread is not None:
            return

        config = uvicorn.Config(
            build_app(self._broadcaster, allowed_hosts_for(self.host), self._recording),
            host=self.host,
            port=self.port,
            log_level="warning",
            lifespan="on",
        )
        # No signal-handler override needed. Uvicorn's capture_signals() already
        # returns early off the main thread, so running here leaves the
        # application's own Ctrl-C handling alone. Overriding it anyway was the
        # obvious defensive move and is dead code — checked against the
        # installed uvicorn rather than assumed.
        server = uvicorn.Server(config)
        self._server = server

        thread = threading.Thread(target=server.run, name="wevna-dashboard", daemon=True)
        self._thread = thread
        thread.start()

        deadline = threading.Event()
        waited = 0.0
        step = 0.02
        while waited < timeout:
            if server.started:
                self._adopt_bound_port(server)
                return
            deadline.wait(step)
            waited += step
        _log.warning("dashboard server did not report started within %ss", timeout)

    def _adopt_bound_port(self, server: uvicorn.Server) -> None:
        """Replaces a requested port 0 with the port the OS actually chose.

        ``port=0`` is how a test, or several services on one machine, asks for a
        free port — and the URL is then useless unless it names that port.
        """
        if self.port != 0:
            return
        for listener in server.servers:
            for sock in listener.sockets:
                self.port = int(sock.getsockname()[1])
                return

    def stop(self, timeout: float = 5.0) -> None:
        """Asks the server to exit and waits for the thread to finish."""
        server, thread = self._server, self._thread
        self._server = None
        self._thread = None
        if server is None or thread is None:
            return
        server.should_exit = True
        thread.join(timeout=timeout)
