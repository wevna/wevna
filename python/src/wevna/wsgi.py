"""WSGI middleware: Flask, Django (WSGI), Bottle, Pyramid...

    app.wsgi_app = WevnaWSGIMiddleware(app.wsgi_app)

See `wevna.flask.install` for the route pattern, which Flask only knows after
its own routing has run.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from . import _client
from ._context import request_scope
from ._exceptions import describe_exception

StartResponse = Callable[..., Any]


def _request_url(environ: Dict[str, Any]) -> str:
    path = environ.get("SCRIPT_NAME", "") + environ.get("PATH_INFO", "")
    query = environ.get("QUERY_STRING", "")
    return f"{path}?{query}" if query else path


class WevnaWSGIMiddleware:
    def __init__(self, app: Callable[..., Iterable[bytes]]) -> None:
        self.app = app

    def __call__(self, environ: Dict[str, Any], start_response: StartResponse) -> Iterable[bytes]:
        status: Dict[str, int] = {}

        def start_response_wrapper(
            status_line: str,
            headers: List[Tuple[str, str]],
            exc_info: Optional[Any] = None,
        ) -> Any:
            try:
                status["code"] = int(status_line.split(" ", 1)[0])
            except ValueError:
                pass
            return start_response(status_line, headers, exc_info)

        started = time.perf_counter()
        with request_scope() as info:
            try:
                # Consumed inside the scope: a streaming response body runs
                # code (queries, logging) that should still be correlated.
                body = self.app(environ, start_response_wrapper)
                try:
                    yield from body
                finally:
                    close = getattr(body, "close", None)
                    if close is not None:
                        close()
            except Exception as error:
                _client.emit("exception.captured", describe_exception(error))
                status.setdefault("code", 500)
                raise
            finally:
                attributes: Dict[str, Any] = {
                    "method": environ.get("REQUEST_METHOD", ""),
                    "url": _request_url(environ),
                    "statusCode": status.get("code", 500),
                    "durationMs": (time.perf_counter() - started) * 1000,
                }
                route = info.get("route")
                if route:
                    attributes["route"] = route
                _client.emit("http.request", attributes)
