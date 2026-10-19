"""Redaction for outgoing request URLs.

A port of the rules in packages/plugin-fetch/src/sanitize-url.ts, kept
deliberately identical so the two SDKs agree on what is safe to record: the
user:pass@ form is dropped, and the *values* of sensitive-looking query
parameters are replaced (keys are kept — "there was an api_key here" is useful,
the secret never is).
"""

from __future__ import annotations

import re
from typing import List
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

REDACTED = "[redacted]"

# Distinctive enough to match anywhere in the name.
_SENSITIVE_SUBSTRINGS = (
    "token",
    "secret",
    "password",
    "passwd",
    "credential",
    "signature",
    "authorization",
    "authentication",
)

# Too short or common to match as substrings ("key" would catch `keyboard`,
# "auth" would catch `author`), so matched only as a whole word.
_SENSITIVE_WORDS = frozenset({"key", "keys", "sig", "apikey", "pwd", "auth"})


def _words(name: str) -> List[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name).lower()
    return [word for word in re.split(r"[^a-z0-9]+", spaced) if word]


def _is_sensitive(name: str) -> bool:
    collapsed = re.sub(r"[^a-z0-9]", "", name.lower())
    if any(pattern in collapsed for pattern in _SENSITIVE_SUBSTRINGS):
        return True
    return any(word in _SENSITIVE_WORDS for word in _words(name))


def sanitize_url(url: str) -> str:
    """Never raises: an unparseable value is returned unchanged."""
    try:
        parts = urlsplit(url)
        netloc = parts.netloc.rpartition("@")[2]
        query = parts.query
        if query:
            pairs = parse_qsl(query, keep_blank_values=True)
            query = urlencode(
                [(key, REDACTED if _is_sensitive(key) else value) for key, value in pairs]
            )
        return urlunsplit((parts.scheme, netloc, parts.path, query, parts.fragment))
    except Exception:  # noqa: BLE001
        return url
