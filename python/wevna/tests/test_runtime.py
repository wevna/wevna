from __future__ import annotations

from wevna import correlation
from wevna.protocol import CapturedEvent, Envelope
from wevna.runtime import Runtime


def event(kind: str = "test") -> CapturedEvent:
    return CapturedEvent(id="e", kind=kind, occurred_at=1)


def collect(runtime: Runtime) -> list[Envelope]:
    seen: list[Envelope] = []
    runtime.subscribe(seen.append)
    return seen


def test_no_session_until_started() -> None:
    runtime = Runtime()
    assert runtime.session is None
    assert not runtime.is_running


def test_start_session_creates_a_running_session() -> None:
    runtime = Runtime()
    session = runtime.start_session()
    assert session.status == "running"
    assert runtime.is_running


def test_start_session_is_idempotent() -> None:
    # start() is the first line of somebody's app. Being called twice — a
    # reload, a test fixture, two entry points — must not produce two sessions
    # publishing interleaved sequence numbers.
    runtime = Runtime()
    first = runtime.start_session()
    assert runtime.start_session() is first


def test_stop_session_marks_it_stopped() -> None:
    runtime = Runtime()
    runtime.start_session()
    runtime.stop_session()
    assert runtime.session is not None
    assert runtime.session.status == "stopped"
    assert not runtime.is_running


def test_stop_session_without_one_is_safe() -> None:
    Runtime().stop_session()


def test_publish_before_start_is_a_no_op() -> None:
    # Making this an error would mean correct instrumentation depended on
    # import order.
    runtime = Runtime()
    seen = collect(runtime)
    runtime.publish(event())
    assert seen == []


def test_publish_after_stop_is_a_no_op() -> None:
    runtime = Runtime()
    runtime.start_session()
    seen = collect(runtime)
    runtime.stop_session()
    runtime.publish(event())
    assert seen == []


def test_publish_wraps_the_event_in_an_envelope() -> None:
    runtime = Runtime()
    session = runtime.start_session()
    seen = collect(runtime)

    runtime.publish(event("sql.query"))

    assert len(seen) == 1
    assert seen[0].session_id == session.id
    assert seen[0].payload.kind == "sql.query"


def test_sequence_numbers_are_monotonic_from_zero() -> None:
    runtime = Runtime()
    runtime.start_session()
    seen = collect(runtime)

    for _ in range(3):
        runtime.publish(event())

    assert [e.sequence for e in seen] == [0, 1, 2]


def test_sequence_resets_for_a_new_session() -> None:
    runtime = Runtime()
    runtime.start_session()
    seen = collect(runtime)
    runtime.publish(event())
    runtime.stop_session()

    runtime.start_session()
    runtime.publish(event())

    assert [e.sequence for e in seen] == [0, 0]


def test_attaches_the_active_correlation() -> None:
    # Attached by the runtime, not the producer: a producer that had to
    # remember would work in the path its author tested and silently lose
    # grouping everywhere else.
    runtime = Runtime()
    runtime.start_session()
    seen = collect(runtime)

    with correlation.start("request-1"):
        runtime.publish(event())

    assert seen[0].payload.correlation is not None
    assert seen[0].payload.correlation.id == "request-1"


def test_omits_correlation_outside_one() -> None:
    runtime = Runtime()
    runtime.start_session()
    seen = collect(runtime)

    runtime.publish(event())

    assert seen[0].payload.correlation is None
    assert "correlation" not in seen[0].to_wire()["payload"]


def test_does_not_overwrite_a_correlation_the_producer_supplied() -> None:
    # A replayed or forwarded event already knows what it belongs to.
    from wevna.protocol import Correlation

    runtime = Runtime()
    runtime.start_session()
    seen = collect(runtime)

    with correlation.start("ambient"):
        runtime.publish(
            CapturedEvent(id="e", kind="k", occurred_at=1, correlation=Correlation(id="explicit"))
        )

    assert seen[0].payload.correlation is not None
    assert seen[0].payload.correlation.id == "explicit"


def test_a_failing_subscriber_does_not_reach_the_publisher() -> None:
    runtime = Runtime()
    runtime.start_session()
    runtime.subscribe(lambda _: (_ for _ in ()).throw(RuntimeError("boom")))
    runtime.publish(event())


class TestConcurrentPublishing:
    """Sync endpoints run in a threadpool, so publish() is called concurrently.

    The Node SDK is single-threaded and never had to think about this: assigning
    a sequence number read the counter, built the envelope, then incremented it,
    and a thread switch between the read and the increment gave two events the
    same sequence number. On a free-threaded build (3.13t+) that is routine
    rather than rare, and sequence is what ordering and recordings rest on.
    """

    def test_every_event_gets_a_unique_sequence_number_in_delivery_order(self) -> None:
        import sys
        import threading

        runtime = Runtime()
        runtime.start_session()
        delivered: list[int] = []
        runtime.subscribe(lambda envelope: delivered.append(envelope.sequence))

        # Make the race show up in milliseconds instead of once a month.
        previous = sys.getswitchinterval()
        sys.setswitchinterval(1e-6)
        try:

            def hammer() -> None:
                for _ in range(1500):
                    runtime.publish(event())

            threads = [threading.Thread(target=hammer) for _ in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        finally:
            sys.setswitchinterval(previous)

        assert len(delivered) == 12000
        assert len(set(delivered)) == 12000, "duplicate sequence numbers"
        assert delivered == sorted(delivered), "delivered out of sequence order"

    def test_a_listener_that_publishes_does_not_deadlock(self) -> None:
        # Logging capture publishes from inside the application's own work, and a
        # listener can reasonably log. Re-entrancy must work.
        runtime = Runtime()
        runtime.start_session()
        seen: list[str] = []

        def listener(envelope: Envelope) -> None:
            seen.append(envelope.payload.kind)
            if envelope.payload.kind == "outer":
                runtime.publish(event("inner"))

        runtime.subscribe(listener)
        runtime.publish(event("outer"))

        assert seen == ["outer", "inner"]
