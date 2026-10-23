"""WSGI middleware: captures every HTTP request, and opens a correlation.

For Flask, Django, Bottle, Pyramid and anything else that speaks WSGI. It is the
synchronous counterpart of ``wevna.asgi.WevnaMiddleware``, produces the same
``http.request`` and ``exception.captured`` events, and is written against the
raw WSGI interface for the same reasons: no dependency, and wrapping a callable
is the interface working as designed rather than a patch.

Usage::

    app.wsgi_app = WevnaMiddleware(app.wsgi_app)        # Flask
    application = WevnaMiddleware(get_wsgi_application())  # Django

WSGI makes two things harder than ASGI, and most of this module is about them.

**The request is not over when the application returns.** The application hands
back an iterable and the *server* pulls the body out of it afterwards, so a
streamed response keeps running application code (queries, logging) after the
call this middleware wraps has returned. Each request therefore runs, and every
step of its body is pulled, inside a context of its own, so that work stays
correlated to its request. The ``http.request`` event is emitted when the
response ends: exhausted, or closed, which WSGI requires servers to do.

**There is no route.** A WSGI application is ``f(environ, start_response)``;
nothing in the interface says which route matched. The matching framework knows,
and ``environ`` is one mutable dict shared by the middleware and the framework,
so a framework hook records the pattern there under ``ROUTE_KEY`` and the
middleware reads it after the application has run. ``wevna.flask`` and
``wevna.django`` are those hooks, each a few lines.
"""

from __future__ import annotations

import contextlib
import contextvars
import logging
import traceback
from collections.abc import Callable, Iterable, Iterator
from time import perf_counter
from typing import Any

from wevna import correlation
from wevna.protocol import CapturedEvent, new_id, now_ms
from wevna.runtime import Runtime

Environ = dict[str, Any]
StartResponse = Callable[..., Any]
WSGIApp = Callable[[Environ, StartResponse], Iterable[bytes]]

_log = logging.getLogger("wevna.wsgi")

ROUTE_KEY = "wevna.route"
"""The ``environ`` key a framework hook sets to the matched route pattern."""

REPORTED_KEY = "wevna.exception_reported"
"""Set in ``environ`` by a framework hook that has already published the exception.

Flask in debug or testing mode, and Django with ``DEBUG_PROPAGATE_EXCEPTIONS``,
report an exception to their hook and then let it propagate, so the middleware
sees it a second time. It checks this key so one exception is one event.
"""


def publish_exception(runtime: Runtime, error: BaseException, framework: str = "wsgi") -> None:
    """Publishes an ``exception.captured`` event. Never raises.

    Public so the framework hooks, which see exceptions the framework would
    otherwise turn into a 500 response before the middleware could, report them
    in exactly the same shape.
    """
    try:
        runtime.publish(
            CapturedEvent(
                id=new_id(),
                kind="exception.captured",
                occurred_at=now_ms(),
                attributes={
                    # The names the dashboard reads, identical to the Node SDK's.
                    "name": type(error).__name__,
                    "message": str(error),
                    "stack": "".join(
                        traceback.format_exception(type(error), error, error.__traceback__)
                    ),
                    "framework": framework,
                },
            )
        )
    except Exception:
        _log.exception("failed to publish an exception.captured event")


class _Response:
    """The wrapped response body, and the end of the request.

    Every step of the body runs in the request's own context. The event is
    emitted once, when the body is exhausted, raises, or is closed, whichever is
    first.
    """

    def __init__(
        self,
        body: Iterable[bytes],
        context: contextvars.Context,
        finish: Callable[[], None],
        fail: Callable[[Exception], None],
    ) -> None:
        self._body = body
        self._iterator: Iterator[bytes] = iter(body)
        self._context = context
        self._finish = finish
        self._fail = fail

    def __iter__(self) -> _Response:
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

    def close(self) -> None:
        # Required of us by WSGI: if the application's iterable has a close(), the
        # server calls ours and ours must call it, even when the body was never
        # read, or the application's own cleanup (a file, a database session) is
        # skipped.
        try:
            close = getattr(self._body, "close", None)
            if close is not None:
                self._context.run(close)
        finally:
            self._context.run(self._finish)


class _SizedResponse(_Response):
    """A wrapped body that keeps the original's ``len()``.

    Servers (wsgiref, gunicorn) set ``Content-Length`` from ``len(body)`` when the
    body is a one-item list. Hiding ``__len__`` would change the response headers,
    so it is passed through whenever the application's body has one.
    """

    def __len__(self) -> int:
        return len(self._body)  # type: ignore[arg-type]


class WevnaMiddleware:
    """Wraps a WSGI application so Wevna can watch it."""

    def __init__(self, app: WSGIApp, runtime: Runtime | None = None) -> None:
        self.app = app
        self._runtime = runtime

    @property
    def runtime(self) -> Runtime:
        if self._runtime is not None:
            return self._runtime
        from wevna import runtime as runtime_module

        return runtime_module.default_runtime()

    def __call__(self, environ: Environ, start_response: StartResponse) -> Iterable[bytes]:
        # One context per request. It is what keeps concurrent requests on
        # one thread (gevent, a thread reused by a pool) from sharing a
        # correlation, and what lets the body be pulled later, from wherever
        # the server pulls it, and still belong to this request.
        context = contextvars.copy_context()
        return context.run(self._handle, context, environ, start_response)

    def _handle(
        self, context: contextvars.Context, environ: Environ, start_response: StartResponse
    ) -> Iterable[bytes]:
        correlation.begin()
        status_code: int | None = None
        started = perf_counter()
        done = False

        def capture_status(
            status: str, headers: list[tuple[str, str]], exc_info: Any = None
        ) -> Any:
            nonlocal status_code
            with contextlib.suppress(ValueError):
                status_code = int(status.split(" ", 1)[0])
            # Forwarded as given, including exc_info, which the WSGI spec allows an
            # application to pass to replace headers it already started.
            if exc_info is None:
                return start_response(status, headers)
            return start_response(status, headers, exc_info)

        def finish() -> None:
            nonlocal done
            if done:
                return
            done = True
            self._publish_request(environ, status_code, started)

        def fail(error: Exception) -> None:
            if not environ.get(REPORTED_KEY):
                publish_exception(self.runtime, error)
            finish()

        try:
            body = self.app(environ, capture_status)
        except Exception as error:
            # Published, then re-raised: observing an exception must not swallow
            # it, because the server's own error handling and the 500 the client
            # is owed both depend on it propagating.
            if not environ.get(REPORTED_KEY):
                publish_exception(self.runtime, error)
            status_code = status_code or 500
            finish()
            raise
        wrapper = _SizedResponse if hasattr(body, "__len__") else _Response
        return wrapper(body, context, finish, fail)

    def _publish_request(self, environ: Environ, status_code: int | None, started: float) -> None:
        duration_ms = (perf_counter() - started) * 1000
        try:
            attributes: dict[str, Any] = {
                "method": environ.get("REQUEST_METHOD", ""),
                "durationMs": duration_ms,
            }
            route = environ.get(ROUTE_KEY)
            if isinstance(route, str) and route:
                attributes["route"] = route

            # The path, not the query string: the same choice the ASGI middleware
            # makes, and one fewer place a token in a URL can end up.
            path = f"{environ.get('SCRIPT_NAME', '')}{environ.get('PATH_INFO', '')}"
            if path:
                attributes["url"] = path
            if status_code is not None:
                attributes["statusCode"] = status_code

            self.runtime.publish(
                CapturedEvent(
                    id=new_id(),
                    kind="http.request",
                    occurred_at=now_ms(),
                    attributes=attributes,
                )
            )
        except Exception:
            _log.exception("failed to publish an http.request event")
