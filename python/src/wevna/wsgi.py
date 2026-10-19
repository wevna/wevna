"""WSGI middleware: Flask, Django (WSGI), Bottle, Pyramid...

    app.wsgi_app = WevnaWSGIMiddleware(app.wsgi_app)

See `wevna.flask.install` and `wevna.django.WevnaDjangoMiddleware` for the
route pattern, which those frameworks only know after their own routing.
"""

from __future__ import annotations

import contextvars
import time
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Tuple

from . import _client
from ._context import begin_request
from ._exceptions import describe_exception

StartResponse = Callable[..., Any]


def _request_url(environ: Dict[str, Any]) -> str:
    path = environ.get("SCRIPT_NAME", "") + environ.get("PATH_INFO", "")
    query = environ.get("QUERY_STRING", "")
    return f"{path}?{query}" if query else path


class _Response:
    """The wrapped response body.

    The request is not over when the app returns — a streamed body keeps
    running application code (queries, logging) as the server pulls from it —
    so the correlation context stays active for every step, and the
    `http.request` event is emitted when the response ends: exhausted, or
    closed, which WSGI requires servers to do.
    """

    def __init__(
        self,
        body: Iterable[bytes],
        context: contextvars.Context,
        finish: Callable[[], None],
    ) -> None:
        self._body = body
        self._iterator: Iterator[bytes] = iter(body)
        self._context = context
        self._finish = finish

    def __iter__(self) -> "_Response":
        return self

    def __next__(self) -> bytes:
        try:
            return self._context.run(next, self._iterator)
        except StopIteration:
            self._context.run(self._finish)
            raise
        except Exception as error:
            self._context.run(self._fail, error)
            raise

    def _fail(self, error: Exception) -> None:
        _client.emit("exception.captured", describe_exception(error))
        self._finish(500)

    def close(self) -> None:
        try:
            close = getattr(self._body, "close", None)
            if close is not None:
                self._context.run(close)
        finally:
            self._context.run(self._finish)


class WevnaWSGIMiddleware:
    def __init__(self, app: Callable[..., Iterable[bytes]]) -> None:
        self.app = app

    def __call__(self, environ: Dict[str, Any], start_response: StartResponse) -> Iterable[bytes]:
        # One context per request, so concurrent requests on one thread (or a
        # body consumed later, from elsewhere) never see each other's id.
        context = contextvars.copy_context()
        return context.run(self._handle, context, environ, start_response)

    def _handle(
        self,
        context: contextvars.Context,
        environ: Dict[str, Any],
        start_response: StartResponse,
    ) -> Iterable[bytes]:
        info = begin_request()
        status: Dict[str, int] = {}
        started = time.perf_counter()
        done = False

        def finish(code: Optional[int] = None) -> None:
            nonlocal done
            if done:
                return
            done = True
            attributes: Dict[str, Any] = {
                "method": environ.get("REQUEST_METHOD", ""),
                "url": _request_url(environ),
                "statusCode": code or status.get("code", 500),
                "durationMs": (time.perf_counter() - started) * 1000,
            }
            route = info.get("route")
            if route:
                attributes["route"] = route
            _client.emit("http.request", attributes)

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

        try:
            body = self.app(environ, start_response_wrapper)
        except Exception as error:
            _client.emit("exception.captured", describe_exception(error))
            finish(500)
            raise
        return _Response(body, context, finish)
