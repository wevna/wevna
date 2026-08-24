# Wevna for Python

**Local-first runtime dashboard for Python backends.**

Part of [Wevna](https://github.com/wevna/wevna) — the same dashboard, the same
recording format, now fed by Python.

> **Status: early. Not on PyPI yet.**
>
> This package currently implements the wire protocol and nothing else. The
> FastAPI/ASGI middleware, per-request correlation and the dashboard host are
> in progress — see the
> [Phase 1 milestone](https://github.com/wevna/wevna/milestone/1).
>
> The [Node SDK](https://www.npmjs.com/package/@wevna/sdk) is stable and
> released today. This is not.

## Why it exists

Wevna's whole premise is that a request's story — the queries it ran, the
calls it made, the logs it wrote — should be something you *look at* rather
than reconstruct from interleaved log lines. That premise is not
language-specific, and the protocol was designed to be a wire format rather
than a TypeScript API.

So a Python producer emitting the same envelopes gets the same dashboard, the
same per-request grouping, the same insights, and recordings that open in the
same viewer.

## What's here today

```python
from wevna import CapturedEvent, Envelope, Session, PROTOCOL_VERSION
```

The protocol types, and the guarantee that what they emit is byte-compatible
with what the Node SDK emits. That guarantee is
[tested](tests/test_conformance.py), not asserted: these tests read
`packages/protocol/schema/` and `packages/protocol/fixtures/` — the *same*
files the TypeScript suite reads — so the two implementations cannot drift
apart without one going red.

## What's coming

| | |
| --- | --- |
| ASGI middleware for FastAPI and Starlette | in progress |
| Per-request correlation via `contextvars` | in progress |
| `logging` capture | in progress |
| The dashboard, served from Python | in progress |
| SQLAlchemy and `asyncpg` | Phase 2 |
| `redis-py` | Phase 2 |
| Recording and replay | Phase 3 |

Phase 3 is the interesting one: because the recording format is shared, a
session recorded from a Python app will open in the same viewer as one
recorded from Node.

## Development

From the repository root:

```bash
pnpm --filter @wevna/python test    # pytest
pnpm --filter @wevna/python check   # mypy, strict
pnpm --filter @wevna/python lint    # ruff
```

Those go through Turborepo alongside the TypeScript packages, so
`pnpm turbo run build check test lint` at the root covers both languages.
The virtualenv is created on first run; no global installs required beyond
Python 3.10+.

To work in it directly:

```bash
cd python/wevna
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/pytest
```

## Design notes

**The wire format is JavaScript's, not Python's.** Keys are `camelCase` and
timestamps are integer milliseconds, matching `Date.now()`. Python names
things `snake_case` internally and converts at the boundary — see
`to_wire()`.

**Absent optional fields are omitted, never `null`.** The TypeScript is
explicit that `correlation` and `source` must be *absent as keys* when unset,
so that a consumer predating a field sees nothing rather than a `null` it has
no branch for. There are tests for this.

**`Envelope` is not generic.** TypeScript has `Envelope<T>`, but only
`CapturedEvent` payloads travel the wire today, and an unused type parameter
would be noise in every annotation. It becomes generic when there is a second
payload type.

## License

[MIT](../../LICENSE)
