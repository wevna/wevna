"""ASGI middleware: captures every HTTP request, and opens a correlation.

Written against the raw ASGI interface rather than Starlette's
``BaseHTTPMiddleware``, for two reasons. It keeps this package dependency-free,
and it means the middleware works with anything ASGI — FastAPI, Starlette,
Quart, Litestar — rather than only the framework it was written against.

This is where the Python and Node SDKs genuinely differ in kind. The Node SDK
patches ``http.Server.prototype.emit``, a global, because Node offers no
supported seam for observing requests. ASGI *is* that seam: an application is
a callable, and wrapping a callable is the interface working as designed. No
global is mutated, nothing is monkeypatched, and removing the middleware
removes every trace of it.
"""

from __future__ import annotations

import logging
import traceback
from collections.abc import Awaitable, Callable, MutableMapping
from time import perf_counter
from typing import Any

from wevna import correlation
from wevna.protocol import CapturedEvent, new_id, now_ms
from wevna.runtime import Runtime

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

_log = logging.getLogger("wevna.asgi")


class WevnaMiddleware:
    """Wraps an ASGI application so Wevna can watch it.

    Usage::

        app.add_middleware(WevnaMiddleware)          # Starlette / FastAPI
        app = WevnaMiddleware(app)                   # any ASGI app
    """

    def __init__(self, app: ASGIApp, runtime: Runtime | None = None) -> None:
        self.app = app
        # Deferred rather than captured: importing the module-level runtime
        # here would make this module impossible to test against a fresh one,
        # and would fix the binding at import time rather than call time.
        self._runtime = runtime

    @property
    def runtime(self) -> Runtime:
        if self._runtime is not None:
            return self._runtime
        from wevna import runtime as runtime_module

        return runtime_module.default_runtime()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # Only HTTP. Lifespan and websocket scopes pass through untouched —
        # wrapping them would mean deciding what a "request" is for a protocol
        # that has no such boundary, and getting it wrong would break the
        # application rather than merely failing to observe it.
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        status_code: int | None = None

        async def send_wrapper(message: Message) -> None:
            nonlocal status_code
            if message.get("type") == "http.response.start":
                status_code = message.get("status")
            await send(message)

        started = perf_counter()

        with correlation.start():
            try:
                await self.app(scope, receive, send_wrapper)
            except Exception as error:
                # Published, then re-raised. Observing an exception must not
                # swallow it: the application's own error handling, and the
                # 500 its client is owed, both depend on it continuing to
                # propagate.
                self._publish_exception(error)
                self._publish_request(scope, status_code or 500, started)
                raise
            else:
                self._publish_request(scope, status_code, started)

    def _publish_request(self, scope: Scope, status_code: int | None, started: float) -> None:
        duration_ms = (perf_counter() - started) * 1000

        try:
            attributes: dict[str, Any] = {
                "method": scope.get("method", ""),
                "durationMs": duration_ms,
            }

            # The route pattern, not the concrete path — "/orders/{id}" rather
            # than "/orders/42" — so a thousand requests to one endpoint group
            # as one route. Read *after* the application ran, because the
            # router sets it during dispatch, which happens inside the call
            # this middleware wraps.
            route = _route_of(scope)
            if route:
                attributes["route"] = route

            path = scope.get("path")
            if isinstance(path, str):
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
            # Never into the caller. This runs on the way out of somebody's
            # request; failing to describe it is acceptable, breaking it is not.
            _log.exception("failed to publish an http.request event")

    def _publish_exception(self, error: BaseException) -> None:
        try:
            self.runtime.publish(
                CapturedEvent(
                    id=new_id(),
                    kind="exception.captured",
                    occurred_at=now_ms(),
                    attributes={
                        # These three attribute names are what the dashboard
                        # reads for an exception. They match the Node SDK's
                        # exactly, which is the only reason a Python exception
                        # renders in the same panel.
                        "name": type(error).__name__,
                        "message": str(error),
                        "stack": "".join(
                            traceback.format_exception(type(error), error, error.__traceback__)
                        ),
                        "framework": "asgi",
                    },
                )
            )
        except Exception:
            _log.exception("failed to publish an exception.captured event")


def _route_of(scope: Scope) -> str | None:
    """The matched route pattern — "/items/{item_id}" rather than "/items/42".

    Two strategies, because ASGI does not specify this and frameworks differ.

    FastAPI records the matched route object in ``scope["route"]`` and exposes
    its pattern as ``.path``, so that is used when present. Bare Starlette does
    not: it records ``endpoint`` and ``path_params`` and no route at all.

    So the fallback reconstructs the pattern by substituting the captured
    parameter values back out of the concrete path. That works for any
    framework populating ``path_params``, which is effectively all of them,
    and needs no knowledge of the framework's routing internals.
    """
    route = scope.get("route")
    path = getattr(route, "path", None)
    if isinstance(path, str):
        return path

    return _reconstruct_route(scope)


def _reconstruct_route(scope: Scope) -> str | None:
    """Rebuilds a route pattern from the path and its captured parameters.

    Matches whole path segments rather than doing a substring replace, so a
    parameter whose value happens to appear inside a literal segment cannot
    corrupt the rest of the pattern. Each parameter name is consumed at most
    once, so two parameters sharing a value still produce two distinct
    placeholders rather than the same one twice.
    """
    path = scope.get("path")
    params = scope.get("path_params")
    if not isinstance(path, str) or not isinstance(params, dict) or not params:
        return None

    remaining: dict[str, list[str]] = {}
    for name, value in params.items():
        remaining.setdefault(str(value), []).append(str(name))

    segments = path.split("/")
    for index, segment in enumerate(segments):
        names = remaining.get(segment)
        if names:
            segments[index] = "{" + names.pop(0) + "}"

    rebuilt = "/".join(segments)
    # If nothing was substituted the path had no parameters in it, in which
    # case the concrete path *is* the pattern and `url` already carries it.
    return rebuilt if rebuilt != path else path
