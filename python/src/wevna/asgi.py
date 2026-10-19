"""ASGI middleware: FastAPI, Starlette, Litestar, Quart, Django (ASGI)...

    app = WevnaMiddleware(app)

Emits one `http.request` event per HTTP request, and opens the correlation
scope everything else (SQL, Redis, outgoing HTTP, logs) attaches to.
"""

from __future__ import annotations

import time
from typing import Any, Awaitable, Callable, Dict, MutableMapping

from . import _client
from ._context import request_scope
from ._exceptions import describe_exception

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]


def _request_url(scope: Scope) -> str:
    path = scope.get("raw_path") or scope.get("path", "")
    if isinstance(path, bytes):
        path = path.decode("latin-1")
    query = scope.get("query_string", b"")
    if isinstance(query, bytes):
        query = query.decode("latin-1")
    return f"{path}?{query}" if query else str(path)


def _route_of(scope: Scope, info: Dict[str, object]) -> object:
    # Starlette/FastAPI put the matched route on the scope once routing has
    # run; its `path` is the pattern ("/orders/{order_id}"), not the URL.
    route = scope.get("route")
    pattern = getattr(route, "path", None)
    if isinstance(pattern, str):
        return pattern
    return info.get("route")


class WevnaMiddleware:
    def __init__(self, app: Callable[..., Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        status: Dict[str, int] = {}

        async def send_wrapper(message: Message) -> None:
            if message.get("type") == "http.response.start":
                status["code"] = int(message["status"])
            await send(message)

        started = time.perf_counter()
        with request_scope() as info:
            try:
                await self.app(scope, receive, send_wrapper)
            except BaseException as error:
                if isinstance(error, Exception):
                    _client.emit("exception.captured", describe_exception(error))
                status.setdefault("code", 500)
                raise
            finally:
                attributes: Dict[str, Any] = {
                    "method": scope.get("method", ""),
                    "url": _request_url(scope),
                    "statusCode": status.get("code", 500),
                    "durationMs": (time.perf_counter() - started) * 1000,
                }
                route = _route_of(scope, info)
                if route:
                    attributes["route"] = route
                _client.emit("http.request", attributes)
