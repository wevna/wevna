"""Raw asyncpg capture, against a real PostgreSQL server.

A stub of asyncpg would test the stub. These tests start a throwaway PostgreSQL in
a temp directory (``initdb`` plus ``postgres``, no Docker, no system service) and
talk to it with real asyncpg, so the behaviors that matter are the real ones:
which statements asyncpg's query logger reports, when, and with what.

Skipped, with a reason, if PostgreSQL's server binaries cannot be found, or when
running as root, which ``initdb`` and ``postgres`` refuse (containers often do).
"""

from __future__ import annotations

import asyncio
import glob
import os
import shutil
import socket
import subprocess
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import asyncpg
import pytest

from wevna import correlation
from wevna.asyncpg import init, init_with, instrument
from wevna.protocol import Envelope
from wevna.runtime import Runtime


def find_postgres_bin() -> Path | None:
    candidates = [shutil.which("initdb")]
    patterns = (
        "/usr/lib/postgresql/*/bin/initdb",  # Debian and Ubuntu, including GitHub runners
        "/opt/homebrew/opt/postgresql@*/bin/initdb",
        "/opt/homebrew/bin/initdb",
        "/usr/local/opt/postgresql@*/bin/initdb",
        "/usr/pgsql-*/bin/initdb",
    )
    for pattern in patterns:
        candidates.extend(sorted(glob.glob(pattern), reverse=True))
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return Path(candidate).parent
    return None


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port: int = s.getsockname()[1]
        return port


@pytest.fixture(scope="module")
def dsn() -> Iterator[str]:
    binaries = find_postgres_bin()
    if binaries is None:
        pytest.skip("PostgreSQL server binaries (initdb, postgres) not found")
    assert binaries is not None
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("initdb and postgres refuse to run as root")

    directory = Path(tempfile.mkdtemp(prefix="wevna-pg-"))
    port = free_port()
    subprocess.run(
        [str(binaries / "initdb"), "-D", str(directory / "data"), "-A", "trust", "-U", "postgres"],
        check=True,
        capture_output=True,
    )
    server = subprocess.Popen(
        [
            str(binaries / "postgres"),
            "-D",
            str(directory / "data"),
            "-p",
            str(port),
            "-k",
            str(directory),
            "-c",
            "listen_addresses=127.0.0.1",
            "-c",
            "fsync=off",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"postgresql://postgres@127.0.0.1:{port}/postgres"
    try:
        deadline = time.time() + 30

        async def ready() -> None:
            while True:
                try:
                    await (await asyncpg.connect(url)).close()
                    return
                except (OSError, asyncpg.PostgresError):
                    if time.time() > deadline:
                        raise
                    await asyncio.sleep(0.1)

        asyncio.run(ready())
        yield url
    finally:
        server.terminate()
        server.wait(timeout=30)
        shutil.rmtree(directory, ignore_errors=True)


@pytest.fixture
def runtime() -> Runtime:
    instance = Runtime()
    instance.start_session()
    return instance


def collect(runtime: Runtime) -> list[Envelope]:
    seen: list[Envelope] = []
    runtime.subscribe(seen.append)
    return seen


def queries(seen: list[Envelope]) -> list[dict[str, Any]]:
    return [e.payload.attributes for e in seen if e.payload.kind == "sql.query"]


async def settle() -> None:
    """asyncpg calls its query loggers shortly after a statement completes."""
    for _ in range(10):
        await asyncio.sleep(0.01)


@pytest.fixture
async def conn(dsn: str, runtime: Runtime) -> Any:
    connection = await asyncpg.connect(dsn)
    await connection.execute("drop table if exists wevna_t")
    await connection.execute("create table wevna_t (id int primary key, email text)")
    instrument(connection, runtime=runtime)
    yield connection
    await connection.close()


class TestConnection:
    async def test_execute_fetch_fetchrow_and_fetchval_each_publish_a_query(
        self, conn: Any, runtime: Runtime
    ) -> None:
        seen = collect(runtime)

        await conn.execute("insert into wevna_t values ($1, $2)", 1, "a@example.com")
        await conn.fetch("select * from wevna_t where id = $1", 1)
        await conn.fetchrow("select * from wevna_t where id = $1", 1)
        await conn.fetchval("select count(*) from wevna_t")
        await settle()

        recorded = queries(seen)
        assert [q["query"] for q in recorded] == [
            "insert into wevna_t values ($1, $2)",
            "select * from wevna_t where id = $1",
            "select * from wevna_t where id = $1",
            "select count(*) from wevna_t",
        ]
        assert all(isinstance(q["durationMs"], float) and q["durationMs"] >= 0 for q in recorded)
        assert all("error" not in q for q in recorded)

    async def test_query_arguments_are_never_recorded(self, conn: Any, runtime: Runtime) -> None:
        seen = collect(runtime)

        await conn.execute("insert into wevna_t values ($1, $2)", 1, "SECRET@example.com")
        await conn.fetch("select * from wevna_t where email = $1", "SECRET@example.com")
        await settle()

        assert "SECRET" not in repr([e.payload for e in seen])

    async def test_a_constraint_violation_is_reported_by_sqlstate_not_message(
        self, conn: Any, runtime: Runtime
    ) -> None:
        await conn.execute("insert into wevna_t values ($1, $2)", 1, "first@example.com")
        seen = collect(runtime)

        with pytest.raises(asyncpg.UniqueViolationError) as raised:
            await conn.execute("insert into wevna_t values ($1, $2)", 1, "dup@example.com")
        await settle()

        # The premise: Postgres puts the offending value in its message.
        assert "(1)" in str(raised.value)
        [failed] = [q for q in queries(seen) if "error" in q]
        assert failed["error"] == "23505"
        assert "dup@example.com" not in repr([e.payload for e in seen])

    async def test_a_failing_statement_is_still_raised_to_the_application(
        self, conn: Any, runtime: Runtime
    ) -> None:
        with pytest.raises(asyncpg.DataError):
            await conn.execute("insert into wevna_t values ($1, $2)", "not-an-int", "x")

    async def test_queries_belong_to_the_current_request(self, conn: Any, runtime: Runtime) -> None:
        seen = collect(runtime)

        with correlation.start("req-1"):
            await conn.fetchval("select 1")
            await settle()  # asyncpg reports it after the statement; same context

        [event] = [e for e in seen if e.payload.kind == "sql.query"]
        assert event.payload.correlation is not None
        assert event.payload.correlation.id == "req-1"

    async def test_executemany_is_one_statement(self, conn: Any, runtime: Runtime) -> None:
        seen = collect(runtime)

        await conn.executemany(
            "insert into wevna_t values ($1, $2)", [(1, "a"), (2, "b"), (3, "c")]
        )
        await settle()

        assert [q["query"] for q in queries(seen)] == ["insert into wevna_t values ($1, $2)"]

    async def test_transaction_control_statements_are_reported_because_they_are_sent(
        self, conn: Any, runtime: Runtime
    ) -> None:
        seen = collect(runtime)

        async with conn.transaction():
            await conn.fetchval("select 1")
        await settle()

        assert [q["query"] for q in queries(seen)] == ["BEGIN;", "select 1", "COMMIT;"]

    async def test_instrumenting_a_connection_twice_does_not_double_the_events(
        self, conn: Any, runtime: Runtime
    ) -> None:
        instrument(conn, runtime=runtime)
        seen = collect(runtime)

        await conn.fetchval("select 1")
        await settle()

        assert len(queries(seen)) == 1

    async def test_the_same_statement_repeated_is_visible_for_n_plus_one_detection(
        self, conn: Any, runtime: Runtime
    ) -> None:
        seen = collect(runtime)

        for item in range(4):
            await conn.fetch("select * from wevna_t where id = $1", item)
        await settle()

        assert len({q["query"] for q in queries(seen)}) == 1
        assert len(queries(seen)) == 4

    async def test_a_failure_while_publishing_never_fails_the_query(
        self, conn: Any, runtime: Runtime
    ) -> None:
        def explode(_envelope: Envelope) -> None:
            raise RuntimeError("subscriber failed")

        runtime.subscribe(explode)

        assert await conn.fetchval("select 41 + 1") == 42
        await settle()


class TestWhatAsyncpgReports:
    """Pinned against the real driver, so a change in asyncpg turns these red."""

    async def test_a_statement_that_fails_to_prepare_is_captured_with_its_sqlstate(
        self, conn: Any, runtime: Runtime
    ) -> None:
        # A missing table or a syntax error fails before execution. asyncpg still
        # logs it (a moment later), which is the most useful kind of failure to see.
        seen = collect(runtime)

        with pytest.raises(asyncpg.UndefinedTableError):
            await conn.fetch("select * from there_is_no_such_table")
        await settle()

        [failed] = queries(seen)
        assert failed["query"] == "select * from there_is_no_such_table"
        assert failed["error"] == "42P01"

    async def test_a_syntax_error_is_captured_with_its_sqlstate(
        self, conn: Any, runtime: Runtime
    ) -> None:
        seen = collect(runtime)

        with pytest.raises(asyncpg.PostgresSyntaxError):
            await conn.execute("selec 1")
        await settle()

        assert [q["error"] for q in queries(seen)] == ["42601"]

    async def test_copy_is_not_logged_by_asyncpg(self, conn: Any, runtime: Runtime) -> None:
        seen = collect(runtime)

        await conn.copy_records_to_table("wevna_t", records=[(9, "x")], columns=["id", "email"])
        await settle()

        assert queries(seen) == [], (
            "asyncpg now logs copy_*; update the docstring and README, which list it as a limit"
        )

    async def test_using_a_custom_type_does_not_leak_asyncpgs_introspection_queries(
        self, conn: Any, runtime: Runtime
    ) -> None:
        await conn.execute("drop type if exists wevna_mood")
        await conn.execute("create type wevna_mood as enum ('sad', 'happy')")
        await settle()  # the create statements above are reported a moment late
        seen = collect(runtime)

        assert await conn.fetchval("select 'happy'::wevna_mood") == "happy"
        await settle()

        recorded = [q["query"] for q in queries(seen)]
        assert recorded == ["select 'happy'::wevna_mood"], recorded


class TestPool:
    async def test_init_instruments_every_connection_the_pool_creates(
        self, dsn: str, runtime: Runtime
    ) -> None:
        import wevna.runtime as runtime_module

        runtime_module.reset_default_runtime()
        default = runtime_module.default_runtime()
        default.start_session()
        seen = collect(default)
        pool = await asyncpg.create_pool(dsn, init=init, min_size=3, max_size=3)
        try:
            await asyncio.gather(
                *(pool.fetchval("select pg_sleep(0.05), $1::int", n) for n in range(3))
            )
            await settle()
        finally:
            await pool.close()
            runtime_module.reset_default_runtime()

        assert len(queries(seen)) == 3

    async def test_init_with_runs_the_users_init_too(self, dsn: str, runtime: Runtime) -> None:
        seen = collect(runtime)
        called: list[bool] = []

        async def mine(connection: Any) -> None:
            called.append(True)
            await connection.execute("set application_name = 'wevna-test'")

        pool = await asyncpg.create_pool(
            dsn, init=init_with(mine, runtime=runtime), min_size=1, max_size=1
        )
        try:
            name = await pool.fetchval("show application_name")
            await settle()
        finally:
            await pool.close()

        assert called == [True]
        assert name == "wevna-test"
        assert "show application_name" in [q["query"] for q in queries(seen)]

    async def test_acquiring_the_same_pooled_connection_repeatedly_adds_no_second_logger(
        self, dsn: str, runtime: Runtime
    ) -> None:
        pool = await asyncpg.create_pool(dsn, min_size=1, max_size=1)
        seen = collect(runtime)
        try:
            for _ in range(3):
                async with pool.acquire() as connection:
                    instrument(connection, runtime=runtime)
            async with pool.acquire() as connection:
                await connection.fetchval("select 1")
            await settle()
        finally:
            await pool.close()

        assert len(queries(seen)) == 1

    async def test_a_pool_query_through_a_shortcut_method_is_captured(
        self, dsn: str, runtime: Runtime
    ) -> None:
        seen = collect(runtime)
        pool = await asyncpg.create_pool(dsn, init=init_with(None, runtime), min_size=1, max_size=1)
        try:
            await pool.execute("select 1")
            await settle()
        finally:
            await pool.close()

        assert [q["query"] for q in queries(seen)] == ["select 1"]


class TestMisuse:
    def test_an_object_without_a_query_logger_warns(self, caplog: pytest.LogCaptureFixture) -> None:
        import logging

        with caplog.at_level(logging.WARNING, logger="wevna.asyncpg"):
            instrument(object())

        assert "cannot instrument" in caplog.text


class TestHousekeepingFilter:
    @pytest.mark.parametrize(
        "query",
        [
            "SELECT pg_advisory_unlock_all();\nCLOSE ALL;\nUNLISTEN *;\nRESET ALL;",
            "CLOSE ALL;\nUNLISTEN *;\nRESET ALL;",
            "RESET ALL;",
            "SELECT pg_advisory_unlock_all()",
            "SELECT current_setting('jit') AS cur, set_config('jit', 'off', false) AS new",
            "\n   SELECT set_config('jit', $1, false)\n  ",
            "WITH RECURSIVE typeinfo_tree( oid, ns, name) AS (SELECT 1)",
        ],
    )
    def test_asyncpgs_own_statements_are_recognized(self, query: str) -> None:
        from wevna.asyncpg import _is_internal

        assert _is_internal(query)

    @pytest.mark.parametrize(
        "query",
        [
            "select 1",
            "RESET ALL; select secret from users",
            "select pg_advisory_unlock_all() from jobs",
            "select set_config('jit', 'on', false), * from settings",
            "with recursive tree as (select 1) select * from tree",
            "",
            ";",
        ],
    )
    def test_an_application_query_is_never_mistaken_for_it(self, query: str) -> None:
        from wevna.asyncpg import _is_internal

        assert not _is_internal(query)
