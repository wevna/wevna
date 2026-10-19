"""Delivery of events to the Wevna dashboard process.

Fire-and-forget by design. Observability must never be able to slow down or
break the application it observes, so:

* `emit()` only appends to an in-memory queue and returns;
* a daemon thread sends batches in the background;
* every failure to deliver (dashboard not running, connection refused, bad
  response) is swallowed, with a single warning the first time it happens;
* the queue is bounded, and drops the oldest events when the dashboard is slow
  or absent rather than growing without limit.
"""

from __future__ import annotations

import atexit
import json
import os
import sys
import threading
import time
import http.client
from urllib.parse import urlsplit
from collections import deque
from typing import Any, Callable, Deque, Dict, List, Optional

from ._context import current_correlation_id

DEFAULT_URL = "http://localhost:4123"
INGEST_PATH = "/api/ingest"
SOURCE = "wevna-python"

MAX_QUEUE = 10_000
# Matches the server's MAX_INGEST_BATCH; a larger batch is rejected outright.
BATCH_SIZE = 500
FLUSH_INTERVAL_SECONDS = 0.1
# Well under the server's body limit, so a batch of large events (long SQL
# statements) is split into several requests rather than rejected whole.
MAX_BODY_BYTES = 1_000_000

Sender = Callable[[List[Dict[str, Any]]], None]


class Client:
    def __init__(
        self,
        url: str = DEFAULT_URL,
        *,
        sender: Optional[Sender] = None,
        flush_interval: float = FLUSH_INTERVAL_SECONDS,
        max_queue: int = MAX_QUEUE,
    ) -> None:
        self._endpoint = url.rstrip("/") + INGEST_PATH
        parts = urlsplit(self._endpoint)
        self._scheme = parts.scheme
        self._host = parts.hostname or "localhost"
        self._port = parts.port
        self._path = parts.path
        # Injectable so tests can observe batches without a socket.
        self._sender = sender or self._post
        self._flush_interval = flush_interval
        self._queue: Deque[Dict[str, Any]] = deque(maxlen=max_queue)
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stopped = threading.Event()
        self._warned = False
        self._start_thread()

    def _start_thread(self) -> None:
        self._thread = threading.Thread(target=self._run, name="wevna-sender", daemon=True)
        self._thread.start()

    def _after_fork_in_child(self) -> None:
        """Make this client usable in a forked worker (gunicorn, uvicorn
        --workers, multiprocessing).

        Only the forking thread survives fork(), so the sender thread is gone;
        the queue holds the parent's unsent events, which the parent will send
        itself; and the lock may have been held by another thread at the
        moment of the fork, which would deadlock the child on first use.
        """
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stopped = threading.Event()
        self._queue.clear()
        self._start_thread()

    def emit(
        self,
        kind: str,
        attributes: Dict[str, Any],
        *,
        occurred_at_ms: Optional[float] = None,
        correlation_id: Optional[str] = None,
    ) -> None:
        event: Dict[str, Any] = {
            "kind": kind,
            "occurredAt": occurred_at_ms if occurred_at_ms is not None else time.time() * 1000,
            "attributes": attributes,
            "source": SOURCE,
        }
        cid = correlation_id or current_correlation_id()
        if cid:
            event["correlation"] = {"id": cid}
        with self._lock:
            self._queue.append(event)
            should_wake = len(self._queue) >= BATCH_SIZE
        if should_wake:
            self._wake.set()

    def flush(self) -> None:
        """Send everything queued right now, on the calling thread."""
        while True:
            with self._lock:
                batch = [self._queue.popleft() for _ in range(min(BATCH_SIZE, len(self._queue)))]
            if not batch:
                return
            self._deliver(batch)

    def close(self) -> None:
        self._stopped.set()
        self._wake.set()
        self._thread.join(timeout=2)
        self.flush()

    def _run(self) -> None:
        while not self._stopped.is_set():
            self._wake.wait(self._flush_interval)
            self._wake.clear()
            self.flush()

    def _deliver(self, batch: List[Dict[str, Any]]) -> None:
        for chunk in _chunk_by_size(batch, MAX_BODY_BYTES):
            try:
                self._sender(chunk)
            except Exception as error:  # noqa: BLE001 - nothing here may reach the app
                self._warn(f"could not reach the dashboard at {self._endpoint} ({error}). "
                           "Events are dropped until it is running; start it with `npx @wevna/sdk`.")

    def _warn(self, message: str) -> None:
        if not self._warned:
            self._warned = True
            print(f"[wevna] {message}", file=sys.stderr)

    def _post(self, batch: List[Dict[str, Any]]) -> None:
        # default=str: an attribute that is not JSON-serialisable must degrade
        # to its repr rather than lose the whole batch.
        body = json.dumps({"events": batch}, default=str).encode("utf-8")
        # http.client rather than urllib.request, on purpose. urllib consults
        # the system proxy settings, which on macOS goes through a framework
        # that crashes a forked child of a threaded process — the exact shape
        # of a pre-fork server. Proxies are also wrong for a localhost
        # dashboard.
        connection_class = (
            http.client.HTTPSConnection if self._scheme == "https" else http.client.HTTPConnection
        )
        connection = connection_class(self._host, self._port, timeout=2)
        try:
            connection.request(
                "POST",
                self._path,
                body=body,
                # application/json is required by the server — see the
                # cross-site note on POST /api/ingest.
                headers={"content-type": "application/json", "content-length": str(len(body))},
            )
            response = connection.getresponse()
            response.read()
            if response.status >= 400:
                raise RuntimeError(f"HTTP {response.status}")
        finally:
            connection.close()


def _chunk_by_size(batch: List[Dict[str, Any]], limit: int) -> List[List[Dict[str, Any]]]:
    """Split a batch into groups whose serialised size stays under `limit`.

    An event that is on its own larger than the limit is dropped: it could
    never be accepted, and sending it would cost the events beside it.
    """
    chunks: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    size = 0
    for event in batch:
        try:
            event_size = len(json.dumps(event, default=str))
        except Exception:  # noqa: BLE001 - an unserialisable event is dropped, not fatal
            continue
        if event_size > limit:
            continue
        if current and size + event_size > limit:
            chunks.append(current)
            current, size = [], 0
        current.append(event)
        size += event_size + 1
    if current:
        chunks.append(current)
    return chunks


_client: Optional[Client] = None
_atexit_registered = False


def _reinit_after_fork() -> None:
    if _client is not None:
        _client._after_fork_in_child()


if hasattr(os, "register_at_fork"):  # not available on Windows
    os.register_at_fork(after_in_child=_reinit_after_fork)


def get_client() -> Optional[Client]:
    return _client


def start_client(url: Optional[str] = None, **kwargs: Any) -> Client:
    global _client, _atexit_registered
    if _client is not None:
        return _client
    _client = Client(url or DEFAULT_URL, **kwargs)
    if not _atexit_registered:
        atexit.register(stop_client)
        _atexit_registered = True
    return _client


def stop_client() -> None:
    global _client
    client, _client = _client, None
    if client is not None:
        client.close()


def emit(kind: str, attributes: Dict[str, Any], **kwargs: Any) -> None:
    """Record an event. A no-op until `wevna.start()` has been called."""
    client = _client
    if client is not None:
        client.emit(kind, attributes, **kwargs)
