"""Outgoing HTTP capture for httpx.

The Python counterpart to ``@wevna/plugin-fetch``. A request that spends 400ms
waiting on a third-party API is indistinguishable from a slow handler until you
can see the call, which is the whole reason this exists.

Wraps ``send`` on a client instance. httpx does offer event hooks, and they are
the documented seam — but a request hook plus a response hook cannot time a
call that never produces a response, and a connection refused or a DNS failure
is exactly the case somebody is trying to see. So this takes the narrow wrap
instead, for the same reason the redis integration does.
"""

from __future__ import annotations

import inspect
import logging
from collections.abc import Callable
from time import perf_counter
from typing import Any

from wevna.protocol import CapturedEvent, new_id, now_ms
from wevna.runtime import Runtime, default_runtime
from wevna.sanitize_url import sanitize_url

_log = logging.getLogger("wevna.httpx")

_INSTRUMENTED = "_wevna_instrumented"


def instrument(
    client: Any,
    runtime: Runtime | None = None,
    ignore_hosts: tuple[str, ...] | list[str] = (),
) -> None:
    """Publishes an ``http.client`` event for every request ``client`` sends.

    Accepts a sync ``Client`` or an ``AsyncClient``; which wrapper is installed
    is decided from the method rather than the class.

    ``ignore_hosts`` keeps a chatty internal dependency out of the stream —
    a metrics sink or a health-check poller that would otherwise bury the calls
    worth looking at.

    What is recorded: method, sanitized URL, status code and duration. What is
    never recorded: headers and bodies. Those are where the credentials and the
    payloads are, and neither is needed to answer which call was slow.
    """
    if getattr(client, _INSTRUMENTED, False):
        return

    original = getattr(client, "send", None)
    if not callable(original):
        _log.warning("cannot instrument %r: no callable send", type(client).__name__)
        return

    ignored = tuple(ignore_hosts)

    def publish(
        request: Any, status: int | None, started: float, error: BaseException | None
    ) -> None:
        try:
            url = str(getattr(request, "url", ""))
            if _is_ignored(url, ignored):
                return

            active = runtime if runtime is not None else default_runtime()
            attributes: dict[str, Any] = {
                "method": str(getattr(request, "method", "")).upper(),
                "url": sanitize_url(url),
                "durationMs": (perf_counter() - started) * 1000,
            }
            if status is not None:
                attributes["statusCode"] = status
            if error is not None:
                # A network-level failure never reaches a status code, and its
                # message is the useful part. Matches the Node plugin, which
                # records error.message rather than a code here — unlike the
                # database producers, an httpx exception message describes the
                # transport rather than quoting the data.
                attributes["error"] = str(error) or type(error).__name__
            active.publish(
                CapturedEvent(
                    id=new_id(),
                    kind="http.client",
                    occurred_at=now_ms(),
                    attributes=attributes,
                )
            )
        except Exception:
            _log.exception("failed to publish an http.client event")

    if inspect.iscoroutinefunction(original):

        async def async_send(request: Any, *args: Any, **kwargs: Any) -> Any:
            started = perf_counter()
            try:
                response = await original(request, *args, **kwargs)
            except Exception as error:
                publish(request, None, started, error)
                raise
            publish(request, getattr(response, "status_code", None), started, None)
            return response

        _install(client, async_send)
        return

    def send(request: Any, *args: Any, **kwargs: Any) -> Any:
        started = perf_counter()
        try:
            response = original(request, *args, **kwargs)
        except Exception as error:
            publish(request, None, started, error)
            raise
        publish(request, getattr(response, "status_code", None), started, None)
        return response

    _install(client, send)


def _install(client: Any, wrapper: Callable[..., Any]) -> None:
    try:
        client.send = wrapper
        client._wevna_instrumented = True
    except Exception:
        _log.warning(
            "could not install the wrapper on %r; outgoing requests will not be captured",
            type(client).__name__,
            exc_info=True,
        )


def _is_ignored(url: str, ignored: tuple[str, ...]) -> bool:
    if not ignored:
        return False
    from urllib.parse import urlsplit

    try:
        host = urlsplit(url).hostname or ""
    except ValueError:
        return False
    return host in ignored
