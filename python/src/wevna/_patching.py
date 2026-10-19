from __future__ import annotations

from typing import Any, Callable, List, Tuple

# (owner, attribute, original) for every patch applied, so uninstrument() can
# put things back exactly as they were.
_applied: List[Tuple[Any, str, Any]] = []


def patch(owner: Any, name: str, make_wrapper: Callable[[Any], Any]) -> None:
    original = getattr(owner, name)
    if getattr(original, "__wevna_wrapped__", False):
        return
    wrapper = make_wrapper(original)
    wrapper.__wevna_wrapped__ = True
    setattr(owner, name, wrapper)
    _applied.append((owner, name, original))


def unpatch_all() -> None:
    while _applied:
        owner, name, original = _applied.pop()
        setattr(owner, name, original)
