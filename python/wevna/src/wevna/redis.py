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

    **Pipelines are not covered.** A pipeline batches commands and sends them
    through its own object, not through the client's ``execute_command``, so
    commands issued inside one are invisible here. Reporting the batch as a
    single misleading event would be worse than reporting nothing, so this
    reports nothing until pipelines get their own handling.
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
