"""Per-request correlation, so events group under the work that caused them.

The Node SDK uses ``AsyncLocalStorage``. Python's direct equivalent is
``contextvars``, and the mapping is exact: a ``ContextVar`` set inside an
async task is visible to everything awaited from it and invisible to sibling
tasks, which is the whole property correlation depends on.

The point of doing it this way — rather than passing a context object into
every function — is that no producer needs to know correlation exists. The
SQLAlchemy listener and the logging handler both just ask "what is current?"
and neither the application nor the other producers had to cooperate.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

from wevna.protocol import Correlation

# Holds the correlation for the current execution flow, or None outside one.
# Module-level by necessity: a ContextVar created per instance would not be
# shared between the middleware that sets it and the producers that read it.
_current: ContextVar[Correlation | None] = ContextVar("wevna_correlation", default=None)


def current() -> Correlation | None:
    """The correlation in effect, or None if nothing is being tracked.

    Producers call this rather than being handed a context, which is what
    lets an event published from deep inside library code still land under
    the right request.
    """
    return _current.get()


@contextmanager
def start(correlation_id: str | None = None) -> Iterator[Correlation]:
    """Runs a block inside a fresh correlation.

    Nesting is allowed and the innermost wins, because the alternative —
    refusing to nest — would mean a background task started inside a request
    could never have its own identity.
    """
    correlation = Correlation(id=correlation_id or str(uuid.uuid4()))
    token = _current.set(correlation)
    try:
        yield correlation
    finally:
        # Reset rather than set-to-None: this restores whatever was in effect
        # before, which is what makes nesting behave.
        _current.reset(token)


@contextmanager
def run_with(correlation: Correlation) -> Iterator[Correlation]:
    """Runs a block inside an existing correlation.

    Exists for the case where the id comes from somewhere else — an inbound
    trace header, or a replayed recording — rather than being minted here.
    """
    token = _current.set(correlation)
    try:
        yield correlation
    finally:
        _current.reset(token)
