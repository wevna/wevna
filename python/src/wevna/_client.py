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
import sys
import threading
import time
import urllib.error
import urllib.request
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
        # Injectable so tests can observe batches without a socket.
        self._sender = sender or self._post
        self._flush_interval = flush_interval
        self._queue: Deque[Dict[str, Any]] = deque(maxlen=max_queue)
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stopped = threading.Event()
        self._warned = False
        self._thread = threading.Thread(target=self._run, name="wevna-sender", daemon=True)
        self._thread.start()

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
        try:
            self._sender(batch)
        except Exception as error:  # noqa: BLE001 - nothing here may reach the app
            if not self._warned:
                self._warned = True
                print(
                    f"[wevna] could not reach the dashboard at {self._endpoint} ({error}). "
                    "Events are dropped until it is running; start it with `npx @wevna/sdk`.",
                    file=sys.stderr,
                )

    def _post(self, batch: List[Dict[str, Any]]) -> None:
        # default=str: an attribute that is not JSON-serialisable must degrade
        # to its repr rather than lose the whole batch.
        body = json.dumps({"events": batch}, default=str).encode("utf-8")
        request = urllib.request.Request(
            self._endpoint,
            data=body,
            # application/json is required by the server — see the cross-site
            # note on POST /api/ingest.
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                response.read()
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"HTTP {error.code}") from error


_client: Optional[Client] = None
_atexit_registered = False


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
