"""The in-process publish/subscribe mechanism the runtime publishes through.

Knows nothing about WebSockets, HTTP or files. It is the single choke point
every producer goes through, which makes it the one place worth enforcing the
guarantee that Wevna never throws into the application it is observing.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import Callable

from wevna.protocol import Envelope

EventListener = Callable[[Envelope], None]

# Wevna's own diagnostics. Deliberately under the "wevna" namespace, because
# the logging capture handler skips this namespace to avoid reporting a failed
# publish by publishing another event.
_log = logging.getLogger("wevna.event_bus")


class EventBus:
    """Fans an envelope out to every subscriber, in subscription order.

    Never raises, and never lets one listener affect another.
    """

    def __init__(self) -> None:
        self._listeners: list[EventListener] = []

    def publish(self, envelope: Envelope) -> None:
        """Delivers to every listener, containing each one's failures.

        Both halves matter, and for different reasons.

        Containment is the stated guarantee: publishing happens on the call
        stack of the application's own work — inside its request handler,
        inside its query — so an exception escaping here would surface as
        Wevna breaking code it was only supposed to be watching.

        Isolation is subtler and was a real bug in the Node SDK. Listeners are
        independent subsystems that happen to share a subscription order, so a
        transport that fails to serialize an event must not stop a recorder
        subscribed after it from ever seeing that event. Without the
        per-listener catch, one bad event silently truncates the recording
        instead of degrading only the subsystem that could not cope.
        """
        for listener in self._listeners:
            try:
                listener(envelope)
            except Exception:
                # exc_info rather than str(error): a listener failing is a
                # Wevna bug or a malformed event, and both need the traceback
                # to be actionable at all.
                _log.exception("an event listener raised; continuing with the rest")

    def subscribe(self, listener: EventListener) -> Callable[[], None]:
        """Registers a listener and returns a function that removes it."""
        self._listeners.append(listener)

        def unsubscribe() -> None:
            # Idempotent on purpose — teardown paths run more than once often
            # enough that raising on a second call would be a trap rather than
            # information.
            with contextlib.suppress(ValueError):
                self._listeners.remove(listener)

        return unsubscribe

    @property
    def listener_count(self) -> int:
        return len(self._listeners)
