"""Raw ``asyncpg`` capture.

SQLAlchemy over asyncpg is already covered by ``wevna.sqlalchemy``. This is for
code that uses asyncpg directly: ``await conn.fetch(...)``, ``pool.execute(...)``.

asyncpg has a supported seam for this, ``Connection.add_query_logger`` (added in
0.29), so nothing is wrapped or patched. It also has a constraint that shapes the
API: a ``Connection`` uses ``__slots__``, so methods cannot be replaced on an
instance, and a ``Pool`` has no query-logger hook of its own. A connection is
instrumented directly, and a pool through the ``init=`` argument asyncpg provides
for per-connection setup::

    conn = await asyncpg.connect(dsn)
    wevna.asyncpg.instrument(conn)

    pool = await asyncpg.create_pool(dsn, init=wevna.asyncpg.init)

What is recorded is a ``sql.query`` event: the statement text, the duration and, on
failure, the SQLSTATE code. What is never recorded: the query arguments, which are
where the data is. asyncpg hands them to the logger and this does not read them.
The error is the SQLSTATE rather than the message, because a Postgres message
quotes the offending value (``Key (email)=(a@b.com) already exists``).

Do not instrument the connections underneath a SQLAlchemy engine that
``wevna.sqlalchemy`` already instruments: every statement would be reported twice.

Limits, all of them asyncpg's own logging:

* ``copy_records_to_table`` and the other ``copy_*`` methods are not logged.
* asyncpg calls the logger shortly after the query completes, so an event is
  published a moment after the statement, not during it.
* ``BEGIN``, ``COMMIT`` and ``ROLLBACK`` are reported, because they are statements
  sent to the server.

Two kinds of statement asyncpg reports that are not the application's, both
filtered out because reporting them would add phantom events and make the
repeated-query insight flag them:

* the reset a pool sends when it takes a connection back
  (``SELECT pg_advisory_unlock_all(); CLOSE ALL; UNLISTEN *; RESET ALL;``), which
  would follow every pooled query;
* the type introspection asyncpg runs the first time an enum, composite, range or
  array of such a type is used (two ``jit`` toggles and a ``typeinfo_tree``
  lookup).
"""

from __future__ import annotations

import logging
import weakref
from collections.abc import Awaitable, Callable
from typing import Any

from wevna.instrumentation_error import describe_error
from wevna.protocol import CapturedEvent, new_id, now_ms
from wevna.runtime import Runtime, default_runtime

_log = logging.getLogger("wevna.asyncpg")

# Connections already given a logger. A WeakSet, because Connection has __slots__
# (so no marker attribute can be set on it) and because a closed connection should
# not be kept alive by this module.
_instrumented: weakref.WeakSet[Any] = weakref.WeakSet()


# Statements asyncpg sends on its own behalf. Matched exactly (after collapsing
# whitespace), never loosely: an application's own query must never be mistaken for
# one, and a missed filter only costs a noisy event.
_RESET_STATEMENTS = frozenset(
    {"SELECT pg_advisory_unlock_all()", "CLOSE ALL", "UNLISTEN *", "RESET ALL"}
)
_INTROSPECTION_QUERIES = frozenset(
    {
        "SELECT current_setting('jit') AS cur, set_config('jit', 'off', false) AS new",
        "SELECT set_config('jit', $1, false)",
    }
)
_INTROSPECTION_PREFIX = "WITH RECURSIVE typeinfo_tree("


def _is_internal(query: str) -> bool:
    """True for the pool's reset and asyncpg's type introspection."""
    # The reset is built from the parts the server supports, so it is matched
    # statement by statement rather than as one string.
    parts = [part.strip() for part in query.split(";") if part.strip()]
    if parts and all(part in _RESET_STATEMENTS for part in parts):
        return True
    collapsed = " ".join(query.split())
    return collapsed in _INTROSPECTION_QUERIES or collapsed.startswith(_INTROSPECTION_PREFIX)


def instrument(connection: Any, runtime: Runtime | None = None) -> None:
    """Publishes a ``sql.query`` event for every statement ``connection`` runs.

    Accepts a ``Connection``, or the proxy a pool hands out from ``acquire()``
    (which is resolved to the connection underneath, so the same connection is
    never given two loggers). Idempotent.
    """
    add = getattr(connection, "add_query_logger", None)
    if not callable(add):
        _log.warning(
            "cannot instrument %r: no add_query_logger (asyncpg 0.29 or newer is required)",
            type(connection).__name__,
        )
        return

    # A pool's proxy forwards to the real connection, which outlives it. Without
    # this, acquiring the same pooled connection twice would add a logger each time.
    target = getattr(connection, "_con", connection)
    try:
        if target in _instrumented:
            return
        _instrumented.add(target)
    except TypeError:
        _log.debug("cannot track %r; it may be instrumented twice", type(target).__name__)

    def log_query(record: Any) -> None:
        try:
            if _is_internal(record.query):
                return
            attributes: dict[str, Any] = {
                # `record.query` only. `record.args` is deliberately never read.
                "query": record.query,
                "durationMs": record.elapsed * 1000,
            }
            if record.exception is not None:
                attributes.update(describe_error(record.exception))
            active = runtime if runtime is not None else default_runtime()
            active.publish(
                CapturedEvent(
                    id=new_id(), kind="sql.query", occurred_at=now_ms(), attributes=attributes
                )
            )
        except Exception:
            _log.exception("failed to publish a sql.query event")

    add(log_query)


async def init(connection: Any) -> None:
    """For ``asyncpg.create_pool(..., init=wevna.asyncpg.init)``.

    asyncpg runs ``init`` once for every connection the pool creates, which is the
    one place a pool's connections can all be reached.
    """
    instrument(connection)


def init_with(
    user_init: Callable[[Any], Awaitable[None]] | None = None,
    runtime: Runtime | None = None,
) -> Callable[[Any], Awaitable[None]]:
    """An ``init`` that also runs your own, for pools that already have one.

    pool = await asyncpg.create_pool(dsn, init=wevna.asyncpg.init_with(my_init))
    """

    async def combined(connection: Any) -> None:
        instrument(connection, runtime)
        if user_init is not None:
            await user_init(connection)

    return combined
