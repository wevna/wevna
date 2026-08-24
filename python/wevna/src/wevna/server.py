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
import json
import logging
import threading
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import uvicorn
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from wevna.protocol import Envelope

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

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
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

        try:
            message = json.dumps(envelope.to_wire())
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


def build_app(broadcaster: _Broadcaster) -> Starlette:
    """The dashboard's own ASGI app — unrelated to the application being watched."""

    async def health(_request: Any) -> JSONResponse:
        # Deliberately identical to the Node SDK's response. Anything checking
        # whether Wevna is up should not have to know which language it is.
        return JSONResponse({"status": "running", "product": "wevna"})

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
        WebSocketRoute("/ws", websocket_endpoint),
    ]

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

    return Starlette(routes=routes, lifespan=lifespan)


class DashboardServer:
    """Runs the dashboard on a background thread."""

    def __init__(self, host: str = "localhost", port: int = 4123) -> None:
        self.host = host
        self.port = port
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
            build_app(self._broadcaster),
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
                return
            deadline.wait(step)
            waited += step
        _log.warning("dashboard server did not report started within %ss", timeout)

    def stop(self, timeout: float = 5.0) -> None:
        """Asks the server to exit and waits for the thread to finish."""
        server, thread = self._server, self._thread
        self._server = None
        self._thread = None
        if server is None or thread is None:
            return
        server.should_exit = True
        thread.join(timeout=timeout)
