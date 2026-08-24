"""How a failed operation is described in an event.

Mirrors the Node SDK's ``describeInstrumentationError`` deliberately, including
its privacy choice: a driver *error code* is preferred over the exception
message, because a message frequently contains the data that caused it —
a constraint violation naming the duplicate value, a type error quoting the
input — while a code never does.

The result is a single ``error`` key so the attribute shape stays identical
across languages. The dashboard renders a failed operation from that key alone.
"""

from __future__ import annotations

from typing import Any

# The attributes drivers expose an error code as, most specific first. psycopg
# and asyncpg both surface SQLSTATE; redis-py has no code and falls through to
# the message, which matches how the Node SDK behaves for ioredis.
_CODE_ATTRIBUTES = ("sqlstate", "pgcode", "code")


def describe_error(error: BaseException) -> dict[str, Any]:
    """A one-key ``{"error": ...}`` describing a failure."""
    for attribute in _CODE_ATTRIBUTES:
        code = getattr(error, attribute, None)
        if isinstance(code, str) and code:
            return {"error": code}

    # SQLAlchemy wraps driver exceptions, so the code usually lives one level
    # down on .orig rather than on the exception the listener receives.
    original = getattr(error, "orig", None)
    if original is not None and original is not error:
        for attribute in _CODE_ATTRIBUTES:
            code = getattr(original, attribute, None)
            if isinstance(code, str) and code:
                return {"error": code}

    return {"error": str(error)}
