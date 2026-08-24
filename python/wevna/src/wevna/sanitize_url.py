"""Reduces an outgoing request URL to something safe to record and still useful.

A direct port of ``packages/plugin-fetch/src/sanitize-url.ts``, deliberately
including its exact rules. These are not two independent implementations that
happen to agree — a Python recording and a Node recording of the same call must
redact the same things, or the redaction is a suggestion rather than a property.

An outgoing URL is the one place credentials routinely end up looking like
harmless metadata: pre-signed URLs, OAuth callbacks and webhook endpoints all
carry secrets in the query string. Keys are kept while values are replaced,
because "there was an api_key here" is useful for debugging and the secret
itself never is.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

REDACTED = "[redacted]"

# Distinctive enough that appearing anywhere in the name is proof of intent.
# "authorization" and "refreshToken" are caught here without being listed.
_SENSITIVE_SUBSTRINGS = (
    "token",
    "secret",
    "password",
    "passwd",
    "credential",
    "signature",
    "auth",
)

# Too short or too common to match as substrings — "key" would redact
# `keyboard_layout` and `monkey_id`, "sig" would redact `sight`. Matched only as
# a whole word within the name, after splitting on separators and camelCase, so
# `x-api-key`, `apiKey` and `API_KEY` are all covered while `keyboard_layout`
# is not.
_SENSITIVE_WORDS = frozenset({"key", "keys", "sig", "apikey", "pwd"})

_CAMEL_BOUNDARY = re.compile(r"([a-z0-9])([A-Z])")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def _words(name: str) -> list[str]:
    spaced = _CAMEL_BOUNDARY.sub(r"\1 \2", name).lower()
    return [word for word in _NON_ALNUM.split(spaced) if word]


def is_sensitive(name: str) -> bool:
    """Whether a query parameter's *value* should be redacted."""
    collapsed = re.sub(r"[^a-z0-9]", "", name.lower())
    if any(pattern in collapsed for pattern in _SENSITIVE_SUBSTRINGS):
        return True
    return any(word in _SENSITIVE_WORDS for word in _words(name))


def sanitize_url(url: str) -> str:
    """Strips userinfo and redacts sensitive query values. Never raises.

    Everything else is kept — scheme, host, port, path, and non-sensitive query
    keys *and* values — because a URL with its path and pagination stripped out
    tells you almost nothing about which call was slow, and answering exactly
    that is the point of capturing outgoing requests at all.

    A value that is not a parseable URL comes back unchanged rather than being
    dropped: an unparseable target is itself worth seeing, and a sanitizer that
    raised would take down the request it was observing.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return url

    if not parts.scheme and not parts.netloc:
        # Not a URL in any useful sense. Returned as-is for the reason above.
        return url

    # Userinfo is credentials by definition, so it goes unconditionally.
    netloc = parts.netloc
    if "@" in netloc:
        netloc = netloc.rsplit("@", 1)[1]

    query = parts.query
    if query:
        pairs = parse_qsl(query, keep_blank_values=True)
        query = urlencode(
            [(name, REDACTED if is_sensitive(name) else value) for name, value in pairs]
        )

    return urlunsplit((parts.scheme, netloc, parts.path, query, parts.fragment))
