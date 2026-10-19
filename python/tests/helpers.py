import threading
from typing import Any, Dict, List

from wevna import _client


class Capture:
    """Installs a Client whose batches land in a list instead of on the wire."""

    def __init__(self) -> None:
        self.events: List[Dict[str, Any]] = []
        self._lock = threading.Lock()

    def __enter__(self) -> "Capture":
        _client.stop_client()
        _client.start_client(sender=self._receive, flush_interval=3600)
        return self

    def __exit__(self, *exc: Any) -> None:
        _client.stop_client()

    def _receive(self, batch: List[Dict[str, Any]]) -> None:
        with self._lock:
            self.events.extend(batch)

    def flushed(self) -> List[Dict[str, Any]]:
        client = _client.get_client()
        assert client is not None
        client.flush()
        with self._lock:
            return list(self.events)

    def of_kind(self, kind: str) -> List[Dict[str, Any]]:
        return [event for event in self.flushed() if event["kind"] == kind]
