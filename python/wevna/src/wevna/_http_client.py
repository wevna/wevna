"""The shared core of the outgoing-HTTP integrations (httpx, requests).

Both libraries expose the same seam: a client or session with a ``send`` method
that takes a request object (``.method``, ``.url``) and returns a response
(``.status_code``). Wrapping that one method on an instance is the smallest
change that covers every request the instance makes, and it has no global effect.
Hooks are not used because a request hook and a response hook cannot time a call
that never produces a response, and a refused connection or a DNS failure is
exactly the case somebody is trying to see.

What differs between the libraries is small and is passed in: the logger, and how
a failure is described. That second one is a security decision, not a detail:
``httpx`` exception messages describe the transport, but ``requests`` embeds the
full URL, query string included, in its messages, so describing a failure with
``str(error)`` would put an ``api_key`` into the event that the URL redaction just
removed from ``url``.
"""

from __future__ import annotations

import contextvars
import inspect
import logging
from collections.abc import Callable
from time import perf_counter
from typing import Any
from urllib.parse import urlsplit

from wevna.protocol import CapturedEvent, new_id, now_ms
from wevna.runtime import Runtime, default_runtime
from wevna.sanitize_url import sanitize_url

INSTRUMENTED = "_wevna_instrumented"

# True while a request that suppresses nested reporting is in progress in this
# context. See ``nested``. A ContextVar, so a request on another thread or task
# is never mistaken for a nested one.
_IN_SEND: contextvars.ContextVar[bool] = contextvars.ContextVar("wevna_in_send", default=False)


def make_publisher(
    *,
    runtime: Runtime | None,
    ignore_hosts: tuple[str, ...] | list[str],
    log: logging.Logger,
    describe_error: Callable[[BaseException], str],
) -> Callable[..., None]:
    """Returns ``publish(request, status, started, error, extra=None)``, never raising.

    ``extra`` is merged into the event's attributes (a library-specific detail such
    as a redirect count)."""
    ignored = tuple(ignore_hosts)

    def publish(
        request: Any,
        status: int | None,
        started: float,
        error: BaseException | None,
        extra: dict[str, Any] | None = None,
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
                attributes["error"] = describe_error(error)
            if extra:
                attributes.update(extra)
            active.publish(
                CapturedEvent(
                    id=new_id(),
                    kind="http.client",
                    occurred_at=now_ms(),
                    attributes=attributes,
                )
            )
        except Exception:
            log.exception("failed to publish an http.client event")

    return publish


def instrument_send(
    client: Any,
    *,
    runtime: Runtime | None,
    ignore_hosts: tuple[str, ...] | list[str],
    log: logging.Logger,
    describe_error: Callable[[BaseException], str],
    response_attributes: Callable[[Any], dict[str, Any]] | None = None,
    suppress_nested: bool = False,
) -> None:
    """Wraps ``client.send`` so every request publishes an ``http.client`` event.

    Idempotent. Sync or async is decided from the method, not the class.

    ``response_attributes`` adds library-specific attributes from the response.
    ``suppress_nested`` is for a library whose ``send`` calls itself (``requests``
    does, once per redirect hop): only the outermost call is reported, as one event
    with the total duration, so the same time is not counted twice.
    """
    if getattr(client, INSTRUMENTED, False):
        return

    original = getattr(client, "send", None)
    if not callable(original):
        log.warning("cannot instrument %r: no callable send", type(client).__name__)
        return

    publish = make_publisher(
        runtime=runtime, ignore_hosts=ignore_hosts, log=log, describe_error=describe_error
    )

    def extra_of(response: Any) -> dict[str, Any] | None:
        if response_attributes is None:
            return None
        try:
            return response_attributes(response)
        except Exception:
            log.exception("failed to read attributes from a response")
            return None

    if inspect.iscoroutinefunction(original):

        async def async_send(request: Any, *args: Any, **kwargs: Any) -> Any:
            started = perf_counter()
            try:
                response = await original(request, *args, **kwargs)
            except Exception as error:
                publish(request, None, started, error)
                raise
            publish(
                request, getattr(response, "status_code", None), started, None, extra_of(response)
            )
            return response

        _install(client, async_send, log)
        return

    def send(request: Any, *args: Any, **kwargs: Any) -> Any:
        if suppress_nested and _IN_SEND.get():
            return original(request, *args, **kwargs)
        token = _IN_SEND.set(True) if suppress_nested else None
        started = perf_counter()
        try:
            response = original(request, *args, **kwargs)
        except Exception as error:
            publish(request, None, started, error)
            raise
        finally:
            if token is not None:
                _IN_SEND.reset(token)
        publish(request, getattr(response, "status_code", None), started, None, extra_of(response))
        return response

    _install(client, send, log)


def _install(client: Any, wrapper: Callable[..., Any], log: logging.Logger) -> None:
    try:
        client.send = wrapper
        setattr(client, INSTRUMENTED, True)
    except Exception:
        log.warning(
            "could not install the wrapper on %r; outgoing requests will not be captured",
            type(client).__name__,
            exc_info=True,
        )


def _is_ignored(url: str, ignored: tuple[str, ...]) -> bool:
    if not ignored:
        return False
    try:
        host = urlsplit(url).hostname or ""
    except ValueError:
        return False
    return host in ignored
