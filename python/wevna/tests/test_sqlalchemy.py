"""SQLAlchemy instrumentation, against real engines and a real database.

sqlite via SQLAlchemy is a real driver, a real cursor and a real event
dispatch. The sync and async engines take different paths through SQLAlchemy —
async runs the DBAPI call inside a greenlet — so both are exercised rather than
one standing in for the other.
"""

from __future__ import annotations

import logging

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.ext.asyncio import create_async_engine

from wevna import correlation
from wevna.protocol import Envelope
from wevna.runtime import Runtime
from wevna.sqlalchemy import instrument


def collect(runtime: Runtime) -> list[Envelope]:
    seen: list[Envelope] = []
    runtime.subscribe(seen.append)
    return seen


def queries(seen: list[Envelope]) -> list[dict[str, object]]:
    return [e.payload.attributes for e in seen if e.payload.kind == "sql.query"]


@pytest.fixture
def runtime() -> Runtime:
    instance = Runtime()
    instance.start_session()
    return instance


class TestSyncEngine:
    def test_publishes_a_sql_query_event(self, runtime: Runtime) -> None:
        engine = create_engine("sqlite://")
        instrument(engine, runtime=runtime)
        seen = collect(runtime)

        with engine.connect() as conn:
            conn.execute(text("select 1"))

        recorded = queries(seen)
        assert len(recorded) == 1
        assert recorded[0]["query"] == "select 1"
        assert isinstance(recorded[0]["durationMs"], float)

    def test_records_a_row_count_when_the_driver_reports_one(self, runtime: Runtime) -> None:
        engine = create_engine("sqlite://")
        instrument(engine, runtime=runtime)
        seen = collect(runtime)

        with engine.begin() as conn:
            conn.execute(text("create table t (id integer, name text)"))
            conn.execute(text("insert into t values (1, 'a'), (2, 'b')"))

        inserts = [q for q in queries(seen) if "insert" in str(q["query"]).lower()]
        assert inserts[0]["rows"] == 2

    def test_instruments_orm_and_core_alike(self, runtime: Runtime) -> None:
        # The events fire at the cursor level, so what sits above it is
        # irrelevant — which is the whole reason one call covers an application.
        engine = create_engine("sqlite://")
        instrument(engine, runtime=runtime)
        seen = collect(runtime)

        with engine.begin() as conn:
            conn.execute(text("create table t (id integer)"))
            conn.execute(text("insert into t values (1)"))
            conn.execute(text("select * from t"))

        assert len(queries(seen)) == 3

    def test_is_idempotent(self, runtime: Runtime) -> None:
        # Startup code runs twice more often than one would like, and a second
        # registration would double every event.
        engine = create_engine("sqlite://")
        instrument(engine, runtime=runtime)
        instrument(engine, runtime=runtime)
        seen = collect(runtime)

        with engine.connect() as conn:
            conn.execute(text("select 1"))

        assert len(queries(seen)) == 1


class TestTheCaptureBoundary:
    """What is deliberately not recorded. The most important tests here."""

    def test_never_records_bound_parameters(self, runtime: Runtime) -> None:
        engine = create_engine("sqlite://")
        instrument(engine, runtime=runtime)
        seen = collect(runtime)

        with engine.begin() as conn:
            conn.execute(text("create table users (id integer, token text)"))
            conn.execute(
                text("insert into users values (:id, :token)"),
                {"id": 1, "token": "super-secret-value"},
            )

        serialized = str(queries(seen))
        assert "super-secret-value" not in serialized
        for attributes in queries(seen):
            assert "parameters" not in attributes
            assert "params" not in attributes

    def test_keeps_the_statement_text_so_the_signature_stays_useful(self, runtime: Runtime) -> None:
        # The trade: text is kept because a parameterised statement contains no
        # data, and without it the repeated-query detector has nothing to group.
        engine = create_engine("sqlite://")
        instrument(engine, runtime=runtime)
        seen = collect(runtime)

        with engine.begin() as conn:
            conn.execute(text("create table users (id integer)"))
            conn.execute(text("select * from users where id = :id"), {"id": 7})

        selects = [q for q in queries(seen) if "select" in str(q["query"]).lower()]
        assert selects[0]["query"] == "select * from users where id = ?"


class TestFailures:
    def test_a_failing_statement_is_still_published(self, runtime: Runtime) -> None:
        # A failed query never reaches after_cursor_execute, so without the
        # handle_error listener the most interesting kind of query is invisible.
        engine = create_engine("sqlite://")
        instrument(engine, runtime=runtime)
        seen = collect(runtime)

        with pytest.raises(Exception), engine.connect() as conn:  # noqa: B017
            conn.execute(text("select * from a_table_that_does_not_exist"))

        recorded = queries(seen)
        assert len(recorded) == 1
        assert "error" in recorded[0]

    def test_the_exception_still_reaches_the_application(self, runtime: Runtime) -> None:
        engine = create_engine("sqlite://")
        instrument(engine, runtime=runtime)

        with pytest.raises(Exception), engine.connect() as conn:  # noqa: B017
            conn.execute(text("this is not sql"))

    def test_the_error_is_a_single_string_key(self, runtime: Runtime) -> None:
        # Matches the Node SDK's attribute shape exactly, so the dashboard
        # renders a failed Python query the same way as a failed Node one.
        engine = create_engine("sqlite://")
        instrument(engine, runtime=runtime)
        seen = collect(runtime)

        with pytest.raises(Exception), engine.connect() as conn:  # noqa: B017
            conn.execute(text("select * from nope"))

        assert isinstance(queries(seen)[0]["error"], str)


class TestCorrelation:
    def test_a_sync_query_joins_the_active_correlation(self, runtime: Runtime) -> None:
        engine = create_engine("sqlite://")
        instrument(engine, runtime=runtime)
        seen = collect(runtime)

        with correlation.start("request-1"), engine.connect() as conn:
            conn.execute(text("select 1"))

        events = [e for e in seen if e.payload.kind == "sql.query"]
        assert events[0].payload.correlation is not None
        assert events[0].payload.correlation.id == "request-1"


class TestAsyncEngine:
    """The async path, which SQLAlchemy runs through a greenlet."""

    async def test_publishes_for_an_async_engine(self, runtime: Runtime) -> None:
        engine = create_async_engine("sqlite+aiosqlite://")
        instrument(engine, runtime=runtime)
        seen = collect(runtime)

        async with engine.connect() as conn:
            await conn.execute(text("select 1"))
        await engine.dispose()

        assert queries(seen)[0]["query"] == "select 1"

    async def test_correlation_survives_sqlalchemys_greenlet_bridge(self, runtime: Runtime) -> None:
        # Not obvious and worth asserting: SQLAlchemy's asyncio support runs the
        # DBAPI call in a greenlet on the same thread. Because the greenlet does
        # not enter a new contextvars Context, the task's correlation is still
        # current inside it — but that is a property of how greenlet and
        # contextvars interact, not something either promises, so it is pinned
        # here rather than assumed.
        engine = create_async_engine("sqlite+aiosqlite://")
        instrument(engine, runtime=runtime)
        seen = collect(runtime)

        with correlation.start("async-request"):
            async with engine.connect() as conn:
                await conn.execute(text("select 1"))
        await engine.dispose()

        events = [e for e in seen if e.payload.kind == "sql.query"]
        assert events, "no sql.query event was published for the async engine"
        assert events[0].payload.correlation is not None
        assert events[0].payload.correlation.id == "async-request"

    async def test_a_failing_async_statement_is_published(self, runtime: Runtime) -> None:
        engine = create_async_engine("sqlite+aiosqlite://")
        instrument(engine, runtime=runtime)
        seen = collect(runtime)

        with pytest.raises(Exception):  # noqa: B017
            async with engine.connect() as conn:
                await conn.execute(text("select * from nope"))
        await engine.dispose()

        assert "error" in queries(seen)[0]


class TestNeverBreaksTheApplication:
    def test_an_unsupported_object_warns_rather_than_raising(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.WARNING, logger="wevna.sqlalchemy"):
            instrument(object())
        assert "cannot instrument" in caplog.text

    def test_a_failing_subscriber_does_not_fail_the_query(self, runtime: Runtime) -> None:
        engine = create_engine("sqlite://")
        instrument(engine, runtime=runtime)
        runtime.subscribe(lambda _: (_ for _ in ()).throw(RuntimeError("subscriber down")))

        with engine.connect() as conn:
            assert conn.execute(text("select 1")).scalar() == 1
