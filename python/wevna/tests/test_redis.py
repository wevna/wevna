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


class TestKnownLimitations:
    def test_pipelined_commands_are_not_captured(self, runtime: Runtime) -> None:
        # Documented rather than fixed. A pipeline sends through its own object,
        # not the client's execute_command. Reporting the batch as one
        # misleading event would be worse than reporting nothing, so nothing is
        # reported until pipelines get their own handling.
        client = fakeredis.FakeRedis()
        instrument(client, runtime=runtime)
        seen = collect(runtime)

        pipe = client.pipeline()
        pipe.set("a", "1")
        pipe.set("b", "2")
        pipe.execute()

        assert commands(seen) == [], (
            "pipelines are known to be uncaptured; if this now passes commands "
            "through execute_command, the docstring and README need updating"
        )


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
