"""Which request the current code is running for.

The Node SDK keeps this in AsyncLocalStorage; here it is a ContextVar, which
follows the same rules: it flows into awaited coroutines and into threads
started with `contextvars.copy_context()` (Starlette's threadpool does this for
sync endpoints), and does not leak between concurrent requests.
"""

from __future__ import annotations

import contextvars
import uuid
from contextlib import contextmanager
from typing import Dict, Iterator, Optional

_correlation_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "wevna_correlation_id", default=None
)

# Filled in by framework hooks once routing has happened (see wevna.flask), so
# the middleware that wraps the whole request can read the route pattern
# ("/orders/<int:id>") after the inner app has finished. A dict rather than a
# plain value because a ContextVar set inside the inner call is not visible to
# the outer middleware, but a mutation of a shared object is.
_request_info: contextvars.ContextVar[Optional[Dict[str, object]]] = contextvars.ContextVar(
    "wevna_request_info", default=None
)


def current_correlation_id() -> Optional[str]:
    return _correlation_id.get()


def set_route(route: str) -> None:
    """Tell Wevna the route pattern handling the current request.

    Frameworks that route inside the wrapped app (Flask, Django) call this so
    the dashboard groups `/orders/1` and `/orders/2` as one endpoint.
    """
    info = _request_info.get()
    if info is not None:
        info["route"] = route


@contextmanager
def request_scope() -> Iterator[Dict[str, object]]:
    """Open a new correlation scope for one incoming request."""
    info: Dict[str, object] = {}
    id_token = _correlation_id.set(uuid.uuid4().hex)
    info_token = _request_info.set(info)
    try:
        yield info
    finally:
        _request_info.reset(info_token)
        _correlation_id.reset(id_token)


def begin_request() -> Dict[str, object]:
    """Open a correlation scope that is never closed.

    For callers that have already moved into a context of their own to discard
    (the WSGI middleware runs each request, and its streamed body, in one
    copied context) — there is nothing to reset, and a reset across the yields
    of a lazily-consumed response would fail.
    """
    info: Dict[str, object] = {}
    _correlation_id.set(uuid.uuid4().hex)
    _request_info.set(info)
    return info
