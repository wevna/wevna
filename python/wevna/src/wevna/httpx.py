"""Outgoing HTTP capture for httpx.

The Python counterpart to ``@wevna/plugin-fetch``. A request that spends 400ms
waiting on a third-party API is indistinguishable from a slow handler until you
can see the call, which is the whole reason this exists.

Wraps ``send`` on a client instance. httpx does offer event hooks, and they are
the documented seam — but a request hook plus a response hook cannot time a
call that never produces a response, and a connection refused or a DNS failure
is exactly the case somebody is trying to see. So this takes the narrow wrap
instead, for the same reason the redis integration does. The wrapping itself is
shared with the ``requests`` integration (``wevna._http_client``).
"""

from __future__ import annotations

import logging
from typing import Any

from wevna._http_client import instrument_send
from wevna.runtime import Runtime

_log = logging.getLogger("wevna.httpx")


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
    instrument_send(
        client,
        runtime=runtime,
        ignore_hosts=ignore_hosts,
        log=_log,
        # A network-level failure never reaches a status code, and its message is
        # the useful part. Matches the Node plugin, which records error.message
        # rather than a code here. An httpx exception message describes the
        # transport ("[Errno 61] Connection refused") rather than quoting the URL.
        describe_error=lambda error: str(error) or type(error).__name__,
    )
