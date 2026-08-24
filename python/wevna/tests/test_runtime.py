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
