"""Outgoing HTTP capture for ``requests``.

The sibling of ``wevna.httpx`` and the Python counterpart to
``@wevna/plugin-fetch``: it publishes an ``http.client`` event per request, with
the method, the URL with credentials and secrets redacted, the status and the
duration. Headers and bodies are never recorded.

Two ways to use it::

    session = requests.Session()
    wevna.requests.instrument(session)        # this session only

    wevna.requests.instrument_all()           # every Session, and requests.get()

``requests.get(url)`` and its siblings build a throwaway ``Session`` for each
call, so there is no instance to instrument. ``instrument_all()`` covers them by
patching ``Session.send`` on the class. That is a global change, the same trade
``@wevna/plugin-fetch`` makes for the global ``fetch``, so it is opt-in, and it
returns a function that undoes it. It also reports calls made by libraries that
use ``requests`` internally, which is often the point.

``Session.send`` calls itself once per redirect hop, so naive wrapping would report
the follow-up request inside the outer one and count its time twice. One event is
reported per call you made: the original URL, the final status, the total duration,
and ``redirects`` (how many hops were followed) when there were any.

The duration is the time until the response headers arrive. With ``stream=True``
the body is read later and is not included.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from time import perf_counter
from typing import Any

from wevna._http_client import _IN_SEND, INSTRUMENTED, instrument_send, make_publisher
from wevna.runtime import Runtime

_log = logging.getLogger("wevna.requests")

_CLASS_WRAPPER = "_wevna_class_wrapper"
_uninstall_all: Callable[[], None] | None = None


def describe_error(error: BaseException) -> str:
    """The exception class, and the class of its root cause. Never its message.

    A ``requests`` exception message contains the URL, query string included:
    ``Max retries exceeded with url: /charge?api_key=...``. The URL is redacted in
    the event's ``url``, so recording the message would put the secret back. The
    class names carry what is useful (``ConnectionError`` caused by
    ``ConnectionRefusedError``, or a ``ReadTimeout``) and cannot carry a secret.
    """
    name = type(error).__name__
    root: BaseException = error
    for _ in range(10):  # bounded: exception chains can, rarely, be cyclic
        nxt = root.__cause__ or root.__context__
        if nxt is None or nxt is root:
            break
        root = nxt
    return name if root is error else f"{name} ({type(root).__name__})"


def instrument(
    session: Any,
    runtime: Runtime | None = None,
    ignore_hosts: tuple[str, ...] | list[str] = (),
) -> None:
    """Publishes an ``http.client`` event for every request ``session`` sends.

    ``ignore_hosts`` keeps a chatty internal dependency out of the stream.
    Idempotent. Does not cover ``requests.get()`` and friends, which use a Session
    of their own: see ``instrument_all``.
    """
    instrument_send(
        session,
        runtime=runtime,
        ignore_hosts=ignore_hosts,
        log=_log,
        describe_error=describe_error,
        response_attributes=response_attributes,
        suppress_nested=True,
    )


def response_attributes(response: Any) -> dict[str, Any]:
    """``redirects``: how many hops were followed to produce this response."""
    history = getattr(response, "history", None)
    return {"redirects": len(history)} if history else {}


def instrument_all(
    runtime: Runtime | None = None,
    ignore_hosts: tuple[str, ...] | list[str] = (),
) -> Callable[[], None]:
    """Instruments every ``requests.Session``, including the throwaway one inside
    ``requests.get()``. Returns a function that removes the patch.

    Idempotent: calling it again returns the same undo function and adds nothing.
    A session that was also given ``instrument(session)`` is reported once.
    """
    global _uninstall_all
    if _uninstall_all is not None:
        return _uninstall_all

    try:
        import requests
    except ImportError as error:  # pragma: no cover - environment dependent
        raise ImportError(
            "wevna.requests.instrument_all() needs the requests package: "
            'pip install "wevna[requests]"'
        ) from error

    original = requests.Session.send
    publish = make_publisher(
        runtime=runtime, ignore_hosts=ignore_hosts, log=_log, describe_error=describe_error
    )

    def send(self: Any, request: Any, *args: Any, **kwargs: Any) -> Any:
        if getattr(self, INSTRUMENTED, False) or _IN_SEND.get():
            # Reported by the wrapper instrument(session) installed, or a redirect
            # hop inside a call that is already being reported.
            return original(self, request, *args, **kwargs)
        token = _IN_SEND.set(True)
        started = perf_counter()
        try:
            response = original(self, request, *args, **kwargs)
        except Exception as error:
            publish(request, None, started, error)
            raise
        finally:
            _IN_SEND.reset(token)
        publish(
            request,
            getattr(response, "status_code", None),
            started,
            None,
            response_attributes(response) or None,
        )
        return response

    setattr(send, _CLASS_WRAPPER, True)
    requests.Session.send = send  # type: ignore[method-assign]

    def uninstall() -> None:
        global _uninstall_all
        if requests.Session.send is send:
            requests.Session.send = original  # type: ignore[method-assign]
        _uninstall_all = None

    _uninstall_all = uninstall
    return uninstall
