# Wevna for Python

**Local-first runtime dashboard for Python backends.**

Part of [Wevna](https://github.com/wevna/wevna) — the same dashboard, the same
protocol, the same recording format, now fed by Python.

```python
import wevna
from wevna.asgi import WevnaMiddleware
from wevna.sqlalchemy import instrument as instrument_sqlalchemy
from wevna.redis import instrument as instrument_redis
from wevna.httpx import instrument as instrument_httpx

wevna.start()

app = FastAPI()
app.add_middleware(WevnaMiddleware)

instrument_sqlalchemy(engine)  # -> sql.query events
instrument_redis(cache)  # -> redis.command events
instrument_httpx(client)  # -> http.client events
```

Open `localhost:4123`. That's the setup.

> **Status: alpha (`0.1.0`), not on PyPI yet.**
>
> Phases 1 and 2 are done: requests, correlation, logging, the dashboard,
> SQLAlchemy, redis-py and outgoing HTTP. Recording and replay are next. The
> [Node SDK](https://www.npmjs.com/package/@wevna/sdk) is the stable one today;
> this is not.
>
> Track it on the [Phase 2 milestone](https://github.com/wevna/wevna/milestone/2).

## Try it

No database or containers needed:

```bash
git clone https://github.com/wevna/wevna.git
cd wevna && pnpm install && pnpm build
pnpm --filter @wevna/python example
```

Then `curl localhost:8000/orders/42` and watch the dashboard. That endpoint has
a deliberate N+1 in it — see
[examples/fastapi](examples/fastapi/README.md).

## What works today

| | |
| --- | --- |
| **HTTP requests** via ASGI middleware | FastAPI, Starlette, and anything ASGI |
| **Per-request correlation** via `contextvars` | automatic; handlers pass nothing |
| **`logging` capture** | levels, logger names, exceptions |
| **Uncaught exceptions** | attached to the request that caused them |
| **The dashboard** | served from your process, on its own thread |
| **SQLAlchemy** | sync and async engines, ORM and Core alike |
| **asyncpg** | connections and pools, used directly |
| **redis-py** | sync and async clients |
| **Outgoing HTTP** | `httpx`, sync and async, with URL redaction |

Install only what you use:

```bash
pip install "wevna[sqlalchemy,redis,httpx,asyncpg]"
```

Each integration is an optional extra. Instrumentation for a library you don't
use shouldn't make you install it.

### The dashboard is not readable by websites

The server refuses requests whose `Host` is not local (DNS rebinding) and
WebSockets whose `Origin` is not local (cross-site WebSocket hijacking:
browsers do not apply the same-origin policy to WebSockets, so without this any
page you visit could stream your SQL and logs). Scripts and `curl` send no
`Origin` and are unaffected. Binding to `0.0.0.0` turns the check off — you have
chosen to be reachable. Same rules as the Node SDK.

### What each one records, and what it never does

| | Recorded | **Never** recorded |
| --- | --- | --- |
| SQLAlchemy | Statement text, duration, row count | **Bound parameters** |
| asyncpg | Statement text, duration, SQLSTATE on failure | **Query arguments** |
| redis-py | Command name, duration | **Arguments. Return values.** |
| httpx | Method, sanitized URL, status, duration | **Headers. Bodies.** |
| `logging` | Formatted message, level, logger | **`record.args`** |

These are the Node SDK's boundaries, not new ones. A Python event stream that
captured more than its Node counterpart would make the protocol a lie, and the
[URL redaction rules](../../packages/plugin-fetch/fixtures/sanitize-url.json)
are literally the same fixture both languages test against.

### asyncpg, used directly

For code that calls asyncpg itself (`await conn.fetch(...)`, `pool.execute(...)`).
SQLAlchemy over asyncpg is covered by `instrument(engine)` above.

```python
conn = await asyncpg.connect(dsn)
wevna.asyncpg.instrument(conn)

pool = await asyncpg.create_pool(dsn, init=wevna.asyncpg.init)
# or, if the pool already has an init:
pool = await asyncpg.create_pool(dsn, init=wevna.asyncpg.init_with(my_init))
```

It uses asyncpg's own `Connection.add_query_logger` (asyncpg 0.29 or newer), so
nothing is wrapped or patched. That hook exists on connections but not on pools,
and a `Connection` cannot have methods replaced (it uses `__slots__`), which is why
a pool is instrumented through the `init=` argument asyncpg provides for
per-connection setup.

What you get is a `sql.query` event per statement with its text, duration and, on
failure, the SQLSTATE (`23505` for a unique violation). The query arguments are never
read. The SQLSTATE is recorded instead of the message because Postgres puts the
offending value in the message (`Key (email)=(a@b.com) already exists`). Statements
that fail to prepare (a missing table, a syntax error) are captured too.

Things worth knowing, all checked against a real PostgreSQL:

- asyncpg also logs statements that are not yours, and these are filtered out: the
  reset a pool sends when it takes a connection back (it would follow every pooled
  query) and the type introspection it runs the first time an enum or composite type
  is used.
- `BEGIN`, `COMMIT` and `ROLLBACK` are reported, because they are statements sent to
  the server.
- `copy_records_to_table` and the other `copy_*` methods are not logged by asyncpg,
  so they are not captured.
- asyncpg calls the logger a moment after the statement completes, so the event is
  published slightly after it, not during it.
- Do not instrument the asyncpg connections underneath a SQLAlchemy engine you have
  already instrumented: every statement would be reported twice.

### Known gaps

- **Redis pipelines are not captured.** A pipeline sends through its own object
  rather than the client's `execute_command`. Reporting a batch as one
  misleading event would be worse than reporting nothing, so nothing is
  reported. There is a test that fails if this ever changes silently.
- **`requests` is not instrumented.** `httpx` is.

## What's next

| | |
| --- | --- |
| Recording and replay | Phase 3 |
| Raw `asyncpg`, `requests`, Redis pipelines | unscheduled |

Phase 3 is the interesting one: the recording format is shared, so a session
recorded from a Python app will open in the same viewer as one recorded from
Node.

## Design notes

**The middleware is raw ASGI, not `BaseHTTPMiddleware`.** That keeps this
package framework-agnostic — it works with Quart or Litestar as readily as
FastAPI — and it means Wevna wraps a callable rather than patching a global.
This is a real difference from the Node SDK, which has to patch
`http.Server.prototype.emit` because Node offers no equivalent seam. Several
of the caveats in [STABILITY.md](../../STABILITY.md) about global patching
simply do not apply on this side.

**`logging`, not `print`.** `print` has no hook, redirecting `sys.stdout` would
change what your application does, and anything worth correlating is logged
rather than printed. Attaching a `logging.Handler` leaves your formatters,
levels, other handlers and propagation exactly as they were.

**Only the formatted message is kept, never `record.args`.** The arguments are
arbitrary objects that get serialized on the way to the dashboard, and they
carry no redaction. `record.getMessage()` already holds everything a reader
displays.

**`start()` is synchronous.** It is called before your event loop exists, often
at import time, so it cannot be a coroutine. The dashboard runs on its own
thread for the same reason — your application keeps its main loop.

**The wire format is JavaScript's.** Keys are `camelCase` and timestamps are
integer milliseconds, matching `Date.now()`. Python names things `snake_case`
internally and converts at the boundary.

## Development

From the repository root — these run through Turborepo alongside the
TypeScript packages, so one command covers both languages:

```bash
pnpm turbo run build check test lint
```

Or individually:

```bash
pnpm --filter @wevna/python test      # pytest
pnpm --filter @wevna/python check     # mypy, strict
pnpm --filter @wevna/python lint      # ruff, lint + format
pnpm --filter @wevna/python example   # the FastAPI demo
```

The virtualenv is built on first run. Nothing global is required beyond Python
3.10+.

To work in it directly:

```bash
cd python/wevna
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/pytest
```

## The protocol is shared, and tested

[`tests/test_conformance.py`](tests/test_conformance.py) reads
`packages/protocol/schema/` and `packages/protocol/fixtures/` — the *same*
files the TypeScript suite reads — rather than a copy vendored here. That is
what makes "a Python event stream is indistinguishable from a Node one" a fact
rather than an intention: the two implementations cannot drift without one of
them going red.

## License

[MIT](../../LICENSE)
