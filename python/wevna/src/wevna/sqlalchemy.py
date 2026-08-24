"""SQLAlchemy instrumentation.

Uses SQLAlchemy's own event system rather than wrapping anything. That is the
same story as the ASGI middleware: where the Node SDK has to monkeypatch
``pg.Pool.query`` because node-postgres offers no seam, SQLAlchemy publishes
documented events for exactly this, so instrumenting it mutates nothing the
application can observe.

One call covers everything above it. Because the events fire at the cursor
level, an application using the ORM, Core, or raw ``text()`` is instrumented
identically, and a driver swap changes nothing here.
"""

from __future__ import annotations

import logging
from time import perf_counter
from typing import TYPE_CHECKING, Any

from sqlalchemy import event

from wevna.instrumentation_error import describe_error
from wevna.protocol import CapturedEvent, new_id, now_ms
from wevna.runtime import Runtime, default_runtime

if TYPE_CHECKING:  # pragma: no cover - typing only
    from sqlalchemy.engine import Engine

_log = logging.getLogger("wevna.sqlalchemy")

# Where the start time is stashed between the before and after events.
# SQLAlchemy documents `context` as scratch space owned by whoever is using it,
# and it is per-execution rather than per-connection — which matters, because a
# connection can have more than one statement in flight across a savepoint.
_STARTED_AT = "_wevna_started_at"

# Marks an engine as already instrumented. Set on the engine rather than kept
# in a module-level set so it cannot outlive the engine and leak it.
_INSTRUMENTED = "_wevna_instrumented"


def instrument(engine: Any, runtime: Runtime | None = None) -> None:
    """Publishes a ``sql.query`` event for every statement ``engine`` executes.

    Accepts an ``Engine`` or an ``AsyncEngine``. Idempotent — instrumenting the
    same engine twice would otherwise double every event, and application
    startup code gets run twice more often than one would like.

    What is recorded: the statement text, a duration, and a row count when the
    driver reports one. What is never recorded: the bound parameters. Statement
    text in a parameterised query normally contains no data, and the parameters
    are exactly where the data is.
    """
    target = _sync_engine_of(engine)
    if target is None:
        _log.warning(
            "cannot instrument %r: expected an Engine or AsyncEngine", type(engine).__name__
        )
        return

    if getattr(target, _INSTRUMENTED, False):
        return

    resolve = runtime if runtime is not None else None

    def publish(attributes: dict[str, Any]) -> None:
        active = resolve if resolve is not None else default_runtime()
        active.publish(
            CapturedEvent(
                id=new_id(), kind="sql.query", occurred_at=now_ms(), attributes=attributes
            )
        )

    @event.listens_for(target, "before_cursor_execute")
    def before_cursor_execute(
        _conn: Any,
        _cursor: Any,
        _statement: str,
        _parameters: Any,
        context: Any,
        _executemany: bool,
    ) -> None:
        # Nothing is published here. A statement that has not finished has no
        # duration, and publishing on entry would mean every failed query
        # appeared twice.
        try:
            setattr(context, _STARTED_AT, perf_counter())
        except Exception:
            # Some dialects pass a context that rejects attribute assignment.
            # Losing the duration is acceptable; raising into the query is not.
            _log.debug("could not stash a start time on the execution context", exc_info=True)

    @event.listens_for(target, "after_cursor_execute")
    def after_cursor_execute(
        _conn: Any,
        cursor: Any,
        statement: str,
        _parameters: Any,
        context: Any,
        _executemany: bool,
    ) -> None:
        try:
            attributes: dict[str, Any] = {
                # `statement`, never `_parameters`. The underscore is a reminder
                # rather than a convention: the parameter is accepted because
                # SQLAlchemy's signature requires it and is deliberately unused.
                "query": statement,
                "durationMs": _elapsed_ms(context),
            }

            rows = getattr(cursor, "rowcount", None)
            # DBAPI uses -1 for "not applicable", which is not a row count and
            # would render as one.
            if isinstance(rows, int) and rows >= 0:
                attributes["rows"] = rows

            publish(attributes)
        except Exception:
            _log.exception("failed to publish a sql.query event")

    @event.listens_for(target, "handle_error")
    def handle_error(exception_context: Any) -> None:
        # A failed statement never reaches after_cursor_execute, so without this
        # a query that raised would be invisible — which is the opposite of
        # useful, since a failing query is the most interesting kind.
        try:
            error = exception_context.original_exception
            attributes: dict[str, Any] = {
                "query": exception_context.statement or "",
                "durationMs": _elapsed_ms(getattr(exception_context, "execution_context", None)),
                **describe_error(error),
            }
            publish(attributes)
        except Exception:
            _log.exception("failed to publish a failed sql.query event")

    setattr(target, _INSTRUMENTED, True)


def _elapsed_ms(context: Any) -> float:
    started = getattr(context, _STARTED_AT, None) if context is not None else None
    if not isinstance(started, float):
        return 0.0
    return (perf_counter() - started) * 1000


def _sync_engine_of(engine: Any) -> Engine | None:
    """The Engine to attach listeners to.

    An AsyncEngine is a façade over a sync one, and the events fire on the
    inner engine — attaching to the façade silently registers listeners nothing
    ever calls, which is worse than failing.
    """
    inner = getattr(engine, "sync_engine", None)
    if inner is not None:
        return inner  # type: ignore[no-any-return]
    if hasattr(engine, "dispatch"):
        return engine  # type: ignore[no-any-return]
    return None
