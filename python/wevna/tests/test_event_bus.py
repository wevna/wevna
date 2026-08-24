from __future__ import annotations

import logging

import pytest

from wevna.event_bus import EventBus
from wevna.protocol import CapturedEvent, Envelope


def envelope(sequence: int = 0) -> Envelope:
    return Envelope(
        session_id="s-1",
        sequence=sequence,
        payload=CapturedEvent(id=f"e-{sequence}", kind="test", occurred_at=1),
    )


def test_delivers_to_a_subscriber() -> None:
    bus = EventBus()
    seen: list[Envelope] = []
    bus.subscribe(seen.append)

    sent = envelope()
    bus.publish(sent)

    assert seen == [sent]


def test_delivers_to_every_subscriber() -> None:
    bus = EventBus()
    first: list[Envelope] = []
    second: list[Envelope] = []
    bus.subscribe(first.append)
    bus.subscribe(second.append)

    bus.publish(envelope())

    assert len(first) == 1
    assert len(second) == 1


def test_unsubscribe_stops_delivery() -> None:
    bus = EventBus()
    seen: list[Envelope] = []
    unsubscribe = bus.subscribe(seen.append)

    unsubscribe()
    bus.publish(envelope())

    assert seen == []


def test_unsubscribe_is_idempotent() -> None:
    # Teardown paths run twice often enough that raising would be a trap.
    bus = EventBus()
    unsubscribe = bus.subscribe(lambda _: None)
    unsubscribe()
    unsubscribe()
    assert bus.listener_count == 0


def test_publishing_with_no_subscribers_is_fine() -> None:
    EventBus().publish(envelope())


def test_does_not_raise_into_the_publisher(caplog: pytest.LogCaptureFixture) -> None:
    # Publishing happens on the call stack of the application's own work, so an
    # exception escaping here would surface as Wevna breaking code it was only
    # supposed to be watching.
    bus = EventBus()

    def explode(_: Envelope) -> None:
        raise RuntimeError("listener exploded")

    bus.subscribe(explode)

    with caplog.at_level(logging.ERROR, logger="wevna.event_bus"):
        bus.publish(envelope())

    assert "listener exploded" in caplog.text


def test_a_failing_listener_does_not_starve_later_ones(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # The regression behind a real Node bug: the recorder subscribes after the
    # transport, so a transport that threw on one event stopped the recorder
    # from ever seeing it — a silently truncated recording.
    bus = EventBus()
    recorder: list[Envelope] = []

    bus.subscribe(lambda _: (_ for _ in ()).throw(RuntimeError("transport exploded")))
    bus.subscribe(recorder.append)

    sent = envelope()
    with caplog.at_level(logging.ERROR, logger="wevna.event_bus"):
        bus.publish(sent)

    assert recorder == [sent]


def test_keeps_delivering_later_events_after_a_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    bus = EventBus()
    calls: list[int] = []

    def flaky(env: Envelope) -> None:
        calls.append(env.sequence)
        if env.sequence == 0:
            raise RuntimeError("transient")

    bus.subscribe(flaky)

    with caplog.at_level(logging.ERROR, logger="wevna.event_bus"):
        bus.publish(envelope(0))
        bus.publish(envelope(1))

    assert calls == [0, 1]


def test_reports_failures_with_a_traceback(caplog: pytest.LogCaptureFixture) -> None:
    bus = EventBus()
    bus.subscribe(lambda _: (_ for _ in ()).throw(ValueError("nope")))

    with caplog.at_level(logging.ERROR, logger="wevna.event_bus"):
        bus.publish(envelope())

    assert any(record.exc_info for record in caplog.records)
