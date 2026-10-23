"""redis-py instrumentation, against a real redis-py client.

fakeredis provides an in-memory server behind redis-py's actual client, so
what is exercised is redis-py's own `execute_command` — which is the thing
being wrapped. A stub of the client would test the stub.
"""

from __future__ import annotations

import logging

import fakeredis
import fakeredis.aioredis
import pytest

from wevna import correlation
from wevna.protocol import Envelope
from wevna.redis import instrument
from wevna.runtime import Runtime


def collect(runtime: Runtime) -> list[Envelope]:
    seen: list[Envelope] = []
    runtime.subscribe(seen.append)
    return seen


def commands(seen: list[Envelope]) -> list[dict[str, object]]:
    return [e.payload.attributes for e in seen if e.payload.kind == "redis.command"]


@pytest.fixture
def runtime() -> Runtime:
    instance = Runtime()
    instance.start_session()
    return instance


class TestSyncClient:
    def test_publishes_a_command_event(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        client.set("k", "v")

        recorded = commands(seen)
        assert len(recorded) == 1
        assert recorded[0]["command"] == "set"
        assert isinstance(recorded[0]["durationMs"], float)

    def test_covers_every_convenience_method_through_one_wrap(self, runtime: Runtime) -> None:
        # execute_command is the single choke point, which is why wrapping one
        # function covers get, set, expire and the rest.
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        client.set("k", "v")
        client.get("k")
        client.expire("k", 60)
        client.delete("k")

        assert [c["command"] for c in commands(seen)] == ["set", "get", "expire", "del"]

    def test_the_command_still_works(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)

        client.set("k", "v")
        assert client.get("k") == b"v"

    def test_lowercases_the_command_to_match_the_node_sdk(self, runtime: Runtime) -> None:
        # ioredis reports "get"; redis-py reports "GET". Unnormalised, the same
        # command from two languages would be two strings in the dashboard's
        # filters and in repeated-command detection.
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        client.get("missing")

        assert commands(seen)[0]["command"] == "get"

    def test_is_idempotent(self, runtime: Runtime) -> None:
        # Wrapping twice would nest the wrappers and double every event.
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        client.get("k")

        assert len(commands(seen)) == 1


class TestTheCaptureBoundary:
    """What is deliberately not recorded. The most important tests here."""

    def test_never_records_command_arguments(self, runtime: Runtime) -> None:
        # Redis commands carry the value inline — SET session:abc <token> — so
        # unlike parameterised SQL there is no safe subset of args to keep.
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        client.set("session:abc", "super-secret-token")

        serialized = str(commands(seen))
        assert "super-secret-token" not in serialized
        assert "session:abc" not in serialized

    def test_records_only_command_and_timing(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        client.set("k", "v")

        assert set(commands(seen)[0]) == {"command", "durationMs"}

    def test_never_records_a_returned_value(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        client.set("k", "the-stored-secret")
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        assert client.get("k") == b"the-stored-secret"
        assert "the-stored-secret" not in str(commands(seen))


class TestFailures:
    def test_a_failing_command_is_published(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        # Wrong number of arguments for the command: a real redis error.
        with pytest.raises(Exception):  # noqa: B017
            client.execute_command("GET")  # type: ignore[no-untyped-call]

        recorded = commands(seen)
        assert recorded[0]["command"] == "get"
        assert "error" in recorded[0]

    def test_the_exception_still_reaches_the_caller(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)

        with pytest.raises(Exception):  # noqa: B017
            client.execute_command("GET")  # type: ignore[no-untyped-call]


class TestCorrelation:
    def test_a_command_joins_the_active_correlation(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        with correlation.start("request-1"):
            client.get("k")

        events = [e for e in seen if e.payload.kind == "redis.command"]
        assert events[0].payload.correlation is not None
        assert events[0].payload.correlation.id == "request-1"


class TestAsyncClient:
    async def test_publishes_for_an_async_client(self, runtime: Runtime) -> None:
        client = fakeredis.aioredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        await client.set("k", "v")
        assert await client.get("k") == b"v"
        await client.aclose()

        assert [c["command"] for c in commands(seen)] == ["set", "get"]

    async def test_correlation_holds_across_an_await(self, runtime: Runtime) -> None:
        client = fakeredis.aioredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        with correlation.start("async-request"):
            await client.get("k")
        await client.aclose()

        events = [e for e in seen if e.payload.kind == "redis.command"]
        assert events[0].payload.correlation is not None
        assert events[0].payload.correlation.id == "async-request"

    async def test_a_failing_async_command_is_published(self, runtime: Runtime) -> None:
        client = fakeredis.aioredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        with pytest.raises(Exception):  # noqa: B017
            await client.execute_command("GET")  # type: ignore[no-untyped-call]
        await client.aclose()

        assert "error" in commands(seen)[0]


class TestPipelines:
    """Each queued command is its own event; the batch is one round trip."""

    def test_every_queued_command_becomes_an_event_in_order(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        pipe = client.pipeline()
        pipe.set("a", "1")
        pipe.get("a")
        pipe.incr("n")
        pipe.execute()

        recorded = commands(seen)
        assert [c["command"] for c in recorded] == ["set", "get", "incrby"]
        assert [c["batchIndex"] for c in recorded] == [0, 1, 2]
        assert {c["batchSize"] for c in recorded} == {3}

    def test_the_commands_of_one_batch_share_an_id_and_two_batches_do_not(
        self, runtime: Runtime
    ) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        for _ in range(2):
            pipe = client.pipeline()
            pipe.set("a", "1")
            pipe.set("b", "2")
            pipe.execute()

        batches = [c["batch"] for c in commands(seen)]
        assert batches[0] == batches[1]
        assert batches[2] == batches[3]
        assert batches[0] != batches[2]

    def test_time_attribution_still_sums_to_the_real_round_trip(self, runtime: Runtime) -> None:
        # Reporting each command with the full batch time would count the round
        # trip N times. An equal share each sums to the real total.
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        pipe = client.pipeline()
        for index in range(5):
            pipe.set(f"k{index}", "v")
        pipe.execute()

        recorded = commands(seen)
        total = recorded[0]["batchDurationMs"]
        assert isinstance(total, float)
        durations = [float(c["durationMs"]) for c in recorded]  # type: ignore[arg-type]
        assert sum(durations) == pytest.approx(total)
        assert {c["batchDurationMs"] for c in recorded} == {total}

    def test_the_commands_are_tiled_across_the_batch_window_in_order(
        self, runtime: Runtime
    ) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        pipe = client.pipeline()
        for index in range(4):
            pipe.set(f"k{index}", "v")
        pipe.execute()

        times = [e.payload.occurred_at for e in seen if e.payload.kind == "redis.command"]
        assert times == sorted(times)

    def test_keys_and_values_are_never_recorded(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        pipe = client.pipeline()
        pipe.set("session:SECRET-KEY", "SECRET-VALUE")
        pipe.get("session:SECRET-KEY")
        pipe.execute()

        assert "SECRET" not in repr([e.payload for e in seen])

    @pytest.mark.parametrize("transaction", [True, False])
    def test_transactions_and_plain_pipelines_both_work(
        self, runtime: Runtime, transaction: bool
    ) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        pipe = client.pipeline(transaction=transaction)
        pipe.set("a", "1")
        pipe.execute()

        [recorded] = commands(seen)
        assert recorded["transaction"] is transaction
        # MULTI and EXEC are the library's wrapping, not the user's commands.
        assert recorded["command"] == "set"

    def test_results_are_returned_unchanged(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)

        pipe = client.pipeline()
        pipe.set("a", "1")
        pipe.get("a")

        assert pipe.execute() == [True, b"1"]

    def test_the_context_manager_form_is_captured(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        with client.pipeline() as pipe:
            pipe.set("a", "1")
            pipe.execute()

        assert [c["command"] for c in commands(seen)] == ["set"]

    def test_client_transaction_with_a_watch_is_captured(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        client.set("counter", 1)
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        def bump(pipe: object) -> None:
            pipe.multi()  # type: ignore[attr-defined]
            pipe.incr("counter")  # type: ignore[attr-defined]

        client.transaction(bump, "counter")

        assert "incrby" in [c["command"] for c in commands(seen)]

    def test_an_empty_pipeline_publishes_nothing(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        assert client.pipeline().execute() == []

        assert commands(seen) == []

    def test_a_failed_command_with_raise_on_error_false_marks_only_that_command(
        self, runtime: Runtime
    ) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        pipe = client.pipeline(transaction=False)
        pipe.set("a", "1")
        pipe.lpush("a", "x")  # wrong type for the key: Redis rejects this one
        pipe.get("a")
        results = pipe.execute(raise_on_error=False)

        assert isinstance(results[1], Exception)
        recorded = commands(seen)
        assert [("error" in c) for c in recorded] == [False, True, False]

    def test_a_batch_that_raises_marks_every_command_and_reraises(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        pipe = client.pipeline(transaction=False)
        pipe.set("a", "1")
        pipe.lpush("a", "x")
        with pytest.raises(Exception):  # noqa: B017
            pipe.execute()

        recorded = commands(seen)
        assert [c["command"] for c in recorded] == ["set", "lpush"]
        assert any("error" in c for c in recorded)

    def test_the_error_from_a_raising_batch_does_not_carry_the_command_arguments(
        self, runtime: Runtime
    ) -> None:
        # redis-py rewrites the raised error to "Command # 2 (LPUSH a secret-value)
        # of pipeline caused error: ...". The arguments must not reach the event.
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        pipe = client.pipeline(transaction=False)
        pipe.set("a", "1")
        pipe.lpush("a", "secret-value")
        with pytest.raises(Exception, match="secret-value"):  # the app still sees it all
            pipe.execute()

        errors = [str(c["error"]) for c in commands(seen) if "error" in c]
        assert errors
        assert all("secret-value" not in e and "Command #" not in e for e in errors)
        assert all("WRONGTYPE" in e for e in errors)

    def test_pipelined_commands_belong_to_the_current_request(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        with correlation.start("req-1"):
            pipe = client.pipeline()
            pipe.set("a", "1")
            pipe.execute()

        [event] = [e for e in seen if e.payload.kind == "redis.command"]
        assert event.payload.correlation is not None
        assert event.payload.correlation.id == "req-1"

    def test_instrumenting_twice_does_not_double_the_events(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        pipe = client.pipeline()
        pipe.set("a", "1")
        pipe.execute()

        assert len(commands(seen)) == 1

    def test_commands_outside_a_pipeline_have_no_batch_marker(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        client.set("a", "1")

        assert "batch" not in commands(seen)[0]

    def test_a_failure_while_publishing_never_fails_the_pipeline(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)

        def explode(_envelope: Envelope) -> None:
            raise RuntimeError("subscriber failed")

        runtime.subscribe(explode)
        pipe = client.pipeline()
        pipe.set("a", "1")

        assert pipe.execute() == [True]

    async def test_async_pipelines_are_captured(self, runtime: Runtime) -> None:
        client = fakeredis.aioredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        async with client.pipeline() as pipe:
            pipe.set("a", "1")
            pipe.get("a")
            results = await pipe.execute()
        await client.aclose()

        assert results == [True, b"1"]
        recorded = commands(seen)
        assert [c["command"] for c in recorded] == ["set", "get"]
        assert {c["batchSize"] for c in recorded} == {2}


class TestNeverBreaksTheApplication:
    def test_an_object_without_execute_command_warns(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.WARNING, logger="wevna.redis"):
            instrument(object())
        assert "cannot instrument" in caplog.text

    def test_a_failing_subscriber_does_not_fail_the_command(self, runtime: Runtime) -> None:
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        runtime.subscribe(lambda _: (_ for _ in ()).throw(RuntimeError("down")))

        client.set("k", "v")
        assert client.get("k") == b"v"
