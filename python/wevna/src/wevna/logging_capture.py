"""Captures the standard library's ``logging`` output as Wevna events.

The Node SDK patches ``console.log``. Python's equivalent is not patching
``print`` — it is attaching a handler to ``logging``, because that is where
Python applications actually write. ``print`` is left alone deliberately: it
has no hook, patching ``sys.stdout`` would change what the application does,
and anything worth correlating is almost always logged rather than printed.

Being a handler rather than a patch has a real consequence: nothing about the
application's own logging changes. Its formatters, levels, other handlers and
propagation all behave exactly as before, because this is one more subscriber
rather than a replacement for anything.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from types import TracebackType

from wevna.protocol import CapturedEvent, new_id

# Records from this namespace are never captured. Wevna's own diagnostics —
# a failed publish, a listener that raised — must not become events, both
# because they are noise in somebody's request timeline and because reporting
# a publishing failure by publishing would recurse.
_OWN_NAMESPACE = "wevna"

PublishEvent = Callable[[CapturedEvent], None]


class WevnaLogHandler(logging.Handler):
    """Publishes a ``log.record`` event for every record it sees."""

    def __init__(self, publish: PublishEvent, level: int = logging.NOTSET) -> None:
        super().__init__(level=level)
        self._publish = publish
        # Guards against a re-entrant record produced while handling one — for
        # instance if a subscriber itself logs through a captured logger. The
        # namespace check below covers Wevna's own logging; this covers the
        # case where somebody else's does it.
        self._handling = False

    def emit(self, record: logging.LogRecord) -> None:
        if self._handling or record.name.split(".")[0] == _OWN_NAMESPACE:
            return

        self._handling = True
        try:
            self._publish(
                CapturedEvent(
                    id=new_id(),
                    kind="log.record",
                    occurred_at=int(record.created * 1000),
                    attributes=_attributes_of(record),
                )
            )
        except Exception:
            # logging.Handler.handleError is the documented way a handler
            # reports its own failure without disturbing the caller — which is
            # exactly the guarantee this whole package is built around.
            self.handleError(record)
        finally:
            self._handling = False


def _attributes_of(record: logging.LogRecord) -> dict[str, object]:
    """What gets recorded about a log record, and what does not.

    Only the *formatted* message is kept, never ``record.args``. Two reasons,
    and either alone would settle it. The arguments are arbitrary
    user-controlled objects that get serialized on the way to a dashboard
    client, so a circular reference or an unserializable value would break the
    transport — this is the exact bug the Node SDK shipped and had to fix. And
    they are the one capture surface with no redaction of any kind, while
    ``record.getMessage()`` already contains everything a reader displays.
    """
    attributes: dict[str, object] = {
        "message": record.getMessage(),
        "level": record.levelname,
        "logger": record.name,
    }

    if record.exc_info is not None:
        attributes["exception"] = _describe_exception(record.exc_info)

    return attributes


def _describe_exception(
    exc_info: tuple[type[BaseException], BaseException, TracebackType | None]
    | tuple[None, None, None],
) -> dict[str, object]:
    exc_type, exc_value, _ = exc_info
    if exc_type is None or exc_value is None:
        return {}
    return {"type": exc_type.__name__, "message": str(exc_value)}


def install(publish: PublishEvent, logger: logging.Logger | None = None) -> Callable[[], None]:
    """Attaches the handler to a logger, returning a function that removes it.

    Defaults to the root logger, which is where records end up once
    propagation has done its work — attaching there captures every logger in
    the application without enumerating them.
    """
    target = logger if logger is not None else logging.getLogger()
    handler = WevnaLogHandler(publish)
    target.addHandler(handler)

    def uninstall() -> None:
        target.removeHandler(handler)

    return uninstall
