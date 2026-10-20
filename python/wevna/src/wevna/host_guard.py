"""Defences against a web page you happen to be visiting talking to the
dashboard server on localhost.

The same two checks, with the same semantics, as the Node SDK's
``packages/server/src/host-guard.ts`` — a Python dashboard that could be read
by any website would make the "nothing leaves your machine" claim false.

1. **Cross-site WebSocket hijacking.** Browsers do not apply the same-origin
   policy to WebSockets, so any page can open ``ws://localhost:4123/ws`` and
   read every SQL query, request and log line the dashboard shows. The browser
   does send an ``Origin``, so the server must refuse one that is not local.

2. **DNS rebinding.** An attacker's own hostname is briefly pointed at
   127.0.0.1, which makes requests to the server *same-origin* for the page.
   The ``Host`` header is then the attacker's name, so refusing unknown hosts
   closes it.

Non-browser clients (curl, a script) send no ``Origin`` and a local ``Host``,
and pass both.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Iterable, MutableMapping
from typing import Any
from urllib.parse import urlsplit

_LOOPBACK = ("localhost", "127.0.0.1", "::1")
_WILDCARD_BINDS = frozenset({"0.0.0.0", "::", "[::]", ""})

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


def allowed_hosts_for(bound_host: str | None) -> tuple[str, ...]:
    """The hostnames a request may address the server by.

    Loopback names always, plus the bound host if the operator chose something
    else. Binding to every interface is a deliberate decision to be reachable,
    so any host is accepted there (``("*",)``).
    """
    if bound_host is not None and bound_host in _WILDCARD_BINDS:
        return ("*",)
    hosts = list(_LOOPBACK)
    if bound_host is not None and bound_host not in hosts:
        hosts.append(bound_host)
    return tuple(hosts)


def hostname_of(host_header: str) -> str:
    """``localhost:4123`` -> ``localhost``, ``[::1]:4123`` -> ``::1``."""
    value = host_header.strip().lower()
    if value.startswith("["):
        end = value.find("]")
        return value if end == -1 else value[1:end]
    colon = value.rfind(":")
    # An unbracketed value with more than one colon is a bare IPv6 address.
    if colon != -1 and value.find(":") == colon:
        return value[:colon]
    return value


def _is_allowed(hostname: str, allowed: Iterable[str]) -> bool:
    allowed = tuple(allowed)
    return "*" in allowed or hostname in allowed


def is_allowed_host(host_header: str | None, allowed: Iterable[str]) -> bool:
    # No Host at all cannot come from a browser, and rebinding always carries
    # the attacker's hostname — so only a Host that is present and foreign is
    # refused.
    if host_header is None:
        return True
    return _is_allowed(hostname_of(host_header), allowed)


def is_allowed_origin(origin_header: str | None, allowed: Iterable[str]) -> bool:
    """An absent Origin is fine (not a browser); a present one must be local.

    ``"null"`` (sandboxed iframes, ``file://``) never is.
    """
    allowed = tuple(allowed)
    if origin_header is None or "*" in allowed:
        return True
    try:
        netloc = urlsplit(origin_header).netloc
    except ValueError:
        return False
    if not netloc:
        return False
    return _is_allowed(hostname_of(netloc), allowed)


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers", []):
        if key.lower() == name:
            return bytes(value).decode("latin-1")
    return None


class HostGuardMiddleware:
    """Pure ASGI, so one piece of code covers both HTTP and WebSocket scopes.

    * Any request whose ``Host`` is foreign is refused (403 / WebSocket close).
    * A WebSocket whose ``Origin`` is foreign is refused before it is accepted.
    """

    def __init__(self, app: ASGIApp, allowed_hosts: Iterable[str]) -> None:
        self.app = app
        self.allowed_hosts = tuple(allowed_hosts)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        kind = scope["type"]
        if kind not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        refused: str | None = None
        if not is_allowed_host(_header(scope, b"host"), self.allowed_hosts):
            refused = "host not allowed"
        elif kind == "websocket" and not is_allowed_origin(
            _header(scope, b"origin"), self.allowed_hosts
        ):
            refused = "origin not allowed"

        if refused is None:
            await self.app(scope, receive, send)
            return

        if kind == "websocket":
            # Closing before accept() is answered with an HTTP 403 handshake
            # failure, so the page never gets an open socket to read from.
            await receive()  # the websocket.connect message
            await send({"type": "websocket.close", "code": 1008})
            return

        body = json.dumps({"error": refused}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
