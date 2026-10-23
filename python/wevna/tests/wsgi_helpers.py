"""Shared helpers for the WSGI tests: drive an app the way a server does."""

from __future__ import annotations

from collections.abc import Iterable
from io import BytesIO
from typing import Any
from wsgiref.util import setup_testing_defaults

from wevna.protocol import Envelope
from wevna.runtime import Runtime


def make_environ(path: str = "/", method: str = "GET", query: str = "") -> dict[str, Any]:
    environ: dict[str, Any] = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "QUERY_STRING": query,
        "wsgi.input": BytesIO(),
    }
    setup_testing_defaults(environ)
    return environ


class Call:
    """One request. ``begin`` calls the app; the body is pulled separately."""

    def __init__(self, app: Any, path: str = "/", method: str = "GET", query: str = "") -> None:
        self.status = ""
        self.headers: list[tuple[str, str]] = []
        self.body: Iterable[bytes] = app(make_environ(path, method, query), self._start_response)

    def _start_response(
        self, status: str, headers: list[tuple[str, str]], exc_info: Any = None
    ) -> Any:
        self.status, self.headers = status, headers
        return lambda data: None

    def read(self) -> bytes:
        """What a server does: iterate the body, then close it."""
        chunks: list[bytes] = []
        try:
            for chunk in self.body:
                chunks.append(chunk)
        finally:
            close = getattr(self.body, "close", None)
            if close is not None:
                close()
        return b"".join(chunks)


def run(app: Any, path: str = "/", method: str = "GET", query: str = "") -> tuple[str, bytes]:
    call = Call(app, path, method, query)
    body = call.read()
    return call.status, body


def collect(runtime: Runtime) -> list[Envelope]:
    seen: list[Envelope] = []
    runtime.subscribe(seen.append)
    return seen


def kinds(envelopes: list[Envelope]) -> list[str]:
    return [e.payload.kind for e in envelopes]
