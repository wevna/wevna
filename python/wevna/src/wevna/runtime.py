"""The runtime: owns the session, the sequence, and the event bus.

Producers hand it a ``CapturedEvent``; it stamps the envelope. Keeping envelope
construction here rather than in each producer is what makes sequence numbers
monotonic and correlation attachment uniform — a producer that had to remember
to do either would eventually forget.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable

from wevna import correlation as correlation_module
from wevna.event_bus import EventBus, EventListener
from wevna.protocol import CapturedEvent, Envelope, Session, now_ms

_log = logging.getLogger("wevna.runtime")


class Runtime:
    """One execution of Wevna.

    Not a singleton by construction — the module-level instance in
    ``wevna.__init__`` is the ergonomic entry point, but tests build their own,
    which is the only reason the sequence counter and session are instance
    state rather than module state.
    """

    def __init__(self) -> None:
        self._bus = EventBus()
        self._session: Session | None = None
        self._sequence = 0

    @property
    def session(self) -> Session | None:
        return self._session

    @property
    def is_running(self) -> bool:
        return self._session is not None and self._session.status == "running"

    @property
    def bus(self) -> EventBus:
        return self._bus

    def start_session(self, session_id: str | None = None) -> Session:
        """Begins a session, or returns the one already running.

        Idempotent because ``start()`` is the first line of somebody's app and
        being called twice — a reload, a test fixture, two entry points — must
        not produce two sessions publishing interleaved sequence numbers.
        """
        if self._session is not None and self._session.status == "running":
            return self._session

        self._session = Session(
            id=session_id or str(uuid.uuid4()),
            started_at=now_ms(),
            status="running",
        )
        self._sequence = 0
        return self._session

    def stop_session(self) -> None:
        """Marks the session stopped. Safe to call when nothing is running."""
        if self._session is None:
            return
        self._session = Session(
            id=self._session.id,
            started_at=self._session.started_at,
            status="stopped",
        )

    def publish(self, event: CapturedEvent) -> None:
        """Wraps an event in an envelope and hands it to the bus.

        Never raises. A producer calls this from inside the application's own
        work, so the same reasoning that governs ``EventBus.publish`` applies
        one level up: if there is no session, or if envelope construction
        somehow fails, the correct outcome is a dropped event and a
        diagnostic, not an exception in somebody's request handler.

        Publishing before ``start()`` is a no-op rather than an error. The
        alternative would make correct instrumentation depend on import order.
        """
        session = self._session
        if session is None or session.status != "running":
            return

        try:
            # Correlation is attached here, not by the producer. A producer
            # that had to remember would work correctly in the code path its
            # author tested and silently lose grouping everywhere else.
            if event.correlation is None:
                active = correlation_module.current()
                if active is not None:
                    event = CapturedEvent(
                        id=event.id,
                        kind=event.kind,
                        occurred_at=event.occurred_at,
                        attributes=event.attributes,
                        correlation=active,
                        source=event.source,
                    )

            envelope = Envelope(
                session_id=session.id,
                sequence=self._sequence,
                payload=event,
            )
            self._sequence += 1
        except Exception:
            _log.exception("failed to build an envelope; dropping the event")
            return

        self._bus.publish(envelope)

    def subscribe(self, listener: EventListener) -> Callable[[], None]:
        return self._bus.subscribe(listener)
