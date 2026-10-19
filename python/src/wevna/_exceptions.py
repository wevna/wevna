from __future__ import annotations

import traceback
from typing import Any, Dict


def describe_exception(error: BaseException, origin: str = "request") -> Dict[str, Any]:
    """The exception.captured payload, in the shape the Node SDK emits."""
    return {
        "name": type(error).__name__,
        "message": str(error),
        "stack": "".join(traceback.format_exception(type(error), error, error.__traceback__)),
        "origin": origin,
    }
