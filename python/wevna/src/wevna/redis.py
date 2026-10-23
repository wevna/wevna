"""redis-py instrumentation.

Unlike SQLAlchemy and ASGI, redis-py offers no event system and no supported
extension point, so this wraps a method — the one place in this package that
does. The wrap is deliberately narrow: ``execute_command`` is the single choke
point every convenience method funnels through, so ``get``, ``set``, ``expire``
and the rest are all covered by replacing one function rather than dozens.

That mirrors what the Node SDK does with ioredis's ``sendCommand`` for the same
reason and with the same trade: it is the smallest possible mutation that still
covers the whole client.
"""

from __future__ import annotations

import inspect
import logging
from collections.abc import Callable
from time import perf_counter
from typing import Any

from wevna.instrumentation_error import describe_error
from wevna.protocol import CapturedEvent, new_id, now_ms
from wevna.runtime import Runtime, default_runtime

_log = logging.getLogger("wevna.redis")

_INSTRUMENTED = "_wevna_instrumented"


def instrument(client: Any, runtime: Runtime | None = None) -> None:
    """Publishes a ``redis.command`` event for every command ``client`` sends.

    Accepts a sync or async ``Redis`` client; the two need different wrappers
    and the right one is chosen from the method itself rather than from the
    class, so a subclass or a test double is handled the same way.

    Idempotent. Wrapping twice would nest the wrappers and double every event.

    What is recorded: the command *name* and a duration. What is never
    recorded: the arguments. Redis commands routinely carry the value inline —
    ``SET session:abc <token>`` — so unlike a parameterised SQL statement there
    is no safe subset of the arguments to keep.

    **Pipelines** are covered through ``client.pipeline()``. A pipeline queues
    commands on its own object and sends them in one round trip, so the client's
    ``execute_command`` never sees them. Each pipeline the client creates has its
    ``execute`` wrapped, and every queued command becomes its own
    ``redis.command`` event, so the counts and the command names stay true. What
    cannot be known is how long each command took, because they share one round
    trip. Each event therefore carries an equal share of the batch's real
    duration (so time attribution still sums to what the round trip cost), and
    the real total is on every event as ``batchDurationMs``. See ``_publish_batch``.
    """
    if getattr(client, _INSTRUMENTED, False):
        return

    original = getattr(client, "execute_command", None)
    if not callable(original):
        _log.warning("cannot instrument %r: no callable execute_command", type(client).__name__)
        return

    def publish(command: str, started: float, error: BaseException | None) -> None:
        try:
            active = runtime if runtime is not None else default_runtime()
            attributes: dict[str, Any] = {
                "command": command,
                "durationMs": (perf_counter() - started) * 1000,
            }
            if error is not None:
                attributes.update(describe_error(error))
            active.publish(
                CapturedEvent(
                    id=new_id(),
                    kind="redis.command",
                    occurred_at=now_ms(),
                    attributes=attributes,
                )
            )
        except Exception:
            _log.exception("failed to publish a redis.command event")

    if inspect.iscoroutinefunction(original):

        async def async_execute_command(*args: Any, **kwargs: Any) -> Any:
            started = perf_counter()
            command = _command_name(args)
            try:
                result = await original(*args, **kwargs)
            except Exception as error:
                # Published then re-raised. The application's own error
                # handling depends on the exception continuing to propagate,
                # and a failed command is the most interesting kind.
                publish(command, started, error)
                raise
            publish(command, started, None)
            return result

        _install(client, async_execute_command)
        _instrument_pipelines(client, runtime)
        return

    def execute_command(*args: Any, **kwargs: Any) -> Any:
        started = perf_counter()
        command = _command_name(args)
        try:
            result = original(*args, **kwargs)
        except Exception as error:
            publish(command, started, error)
            raise
        publish(command, started, None)
        return result

    _install(client, execute_command)
    _instrument_pipelines(client, runtime)


def _instrument_pipelines(client: Any, runtime: Runtime | None) -> None:
    """Wraps ``client.pipeline`` so every pipeline it creates is observed."""
    original_pipeline = getattr(client, "pipeline", None)
    if not callable(original_pipeline):
        return

    def pipeline(*args: Any, **kwargs: Any) -> Any:
        created = original_pipeline(*args, **kwargs)
        try:
            _wrap_execute(created, runtime)
        except Exception:
            # A pipeline we cannot observe is still a working pipeline.
            _log.warning("could not instrument a pipeline", exc_info=True)
        return created

    try:
        client.pipeline = pipeline
    except Exception:
        _log.warning(
            "could not install the pipeline wrapper on %r; pipelines will not be captured",
            type(client).__name__,
            exc_info=True,
        )


def _wrap_execute(pipe: Any, runtime: Runtime | None) -> None:
    original = getattr(pipe, "execute", None)
    if not callable(original) or getattr(pipe, _INSTRUMENTED, False):
        return

    if inspect.iscoroutinefunction(original):

        async def async_execute(*args: Any, **kwargs: Any) -> Any:
            commands = _queued_commands(pipe)
            started = perf_counter()
            try:
                results = await original(*args, **kwargs)
            except Exception as error:
                _publish_batch(runtime, pipe, commands, started, None, error)
                raise
            _publish_batch(runtime, pipe, commands, started, results, None)
            return results

        pipe.execute = async_execute
    else:

        def execute(*args: Any, **kwargs: Any) -> Any:
            commands = _queued_commands(pipe)
            started = perf_counter()
            try:
                results = original(*args, **kwargs)
            except Exception as error:
                _publish_batch(runtime, pipe, commands, started, None, error)
                raise
            _publish_batch(runtime, pipe, commands, started, results, None)
            return results

        pipe.execute = execute
    pipe._wevna_instrumented = True


def _queued_commands(pipe: Any) -> list[str]:
    """The names of the commands queued right now. Read before ``execute``,
    which clears the queue. Names only: ``args[0]``, never the payload."""
    try:
        return [_command_name(tuple(entry[0])) for entry in pipe.command_stack]
    except Exception:
        return []


def _publish_batch(
    runtime: Runtime | None,
    pipe: Any,
    commands: list[str],
    started: float,
    results: Any,
    error: BaseException | None,
) -> None:
    """Publishes one ``redis.command`` per command in a pipeline, as a batch.

    A pipeline is one round trip, so a per-command duration does not exist. Each
    command is given an equal share of the real total, tiled across the window the
    batch occupied, which keeps the timeline readable and keeps time attribution
    summing to what the round trip actually cost. The total is also written on
    every event as ``batchDurationMs``, and ``batch`` is a shared id, so an
    estimate is never mistaken for a measurement.

    Errors: if ``execute`` raised, every command in the batch gets the error. If it
    returned (``raise_on_error=False``), a result that is an exception marks only
    that command.
    """
    if not commands:
        return
    try:
        active = runtime if runtime is not None else default_runtime()
        total_ms = (perf_counter() - started) * 1000
        count = len(commands)
        share = total_ms / count
        ended = now_ms()
        began = ended - total_ms
        batch_id = new_id()
        transaction = bool(getattr(pipe, "transaction", False))

        for index, command in enumerate(commands):
            attributes: dict[str, Any] = {
                "command": command,
                "durationMs": share,
                "batch": batch_id,
                "batchSize": count,
                "batchIndex": index,
                "batchDurationMs": total_ms,
                "transaction": transaction,
            }
            failure: BaseException | None = error
            if failure is None and isinstance(results, list) and index < len(results):
                candidate = results[index]
                if isinstance(candidate, BaseException):
                    failure = candidate
            if failure is not None:
                attributes.update(describe_error(failure))
            active.publish(
                CapturedEvent(
                    id=new_id(),
                    kind="redis.command",
                    occurred_at=int(began + share * (index + 1)),
                    attributes=attributes,
                )
            )
    except Exception:
        _log.exception("failed to publish the redis.command events for a pipeline")


def _install(client: Any, wrapper: Callable[..., Any]) -> None:
    try:
        client.execute_command = wrapper
        client._wevna_instrumented = True
    except Exception:
        # A client using __slots__, or a frozen wrapper. Failing to observe is
        # acceptable; raising out of somebody's startup is not.
        _log.warning(
            "could not install the wrapper on %r; commands will not be captured",
            type(client).__name__,
            exc_info=True,
        )


def _command_name(args: tuple[Any, ...]) -> str:
    """The command name, lowercased, from redis-py's first positional argument.

    Lowercased to match the Node SDK, which reads ioredis's ``command.name``
    and gets ``"get"`` where redis-py gives ``"GET"``. Without normalising,
    the same command from two languages would be two different strings in the
    dashboard's filters and in repeated-command detection.

    Only ``args[0]`` is ever read. Everything after it is the payload.
    """
    if not args:
        return ""
    first = args[0]
    if isinstance(first, bytes):
        return first.decode("utf-8", errors="replace").lower()
    return str(first).lower()
