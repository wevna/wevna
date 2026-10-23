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
> Phases 1 to 3 are done: requests, correlation, logging, the dashboard,
> SQLAlchemy, redis-py, outgoing HTTP, and recording and replay. The
> [Node SDK](https://www.npmjs.com/package/@wevna/sdk) is the stable one today;
> this is not.

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
| **redis-py** | sync and async clients |
| **Outgoing HTTP** | `httpx`, sync and async, with URL redaction |
| **Recording and replay** | JSON Lines, the same format as the Node SDK |

Install only what you use:

```bash
pip install "wevna[sqlalchemy,redis,httpx]"
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
| redis-py | Command name, duration | **Arguments. Return values.** |
| httpx | Method, sanitized URL, status, duration | **Headers. Bodies.** |
| `logging` | Formatted message, level, logger | **`record.args`** |

These are the Node SDK's boundaries, not new ones. A Python event stream that
captured more than its Node counterpart would make the protocol a lie, and the
[URL redaction rules](../../packages/plugin-fetch/fixtures/sanitize-url.json)
are literally the same fixture both languages test against.

### Recording and replay

Record a session to a file, and open it later in the same dashboard, with
restart, step, play and a seek bar. The file is JSON Lines in the same format
the Node SDK writes, so a recording from either SDK opens in either one.

```python
wevna.start()
wevna.start_recording("session.jsonl")  # writes until stop_recording() or exit
...
wevna.stop_recording()  # optional: stop() and normal exit do it too
```

```python
wevna.open_recording("session.jsonl")  # serves it at localhost:4123
```

- `start_recording()` may be called before `start()`. The request is held and
  begins when `start()` creates a session, the same as in the Node SDK. If the
  file cannot be opened at that point the error is logged, since there is no
  caller left to raise it to. Called after `start()` it raises `OSError`.
- A second `start_recording()` while recording does nothing. The file is
  appended to if it already exists.
- The footer is written on `stop_recording()`, on `wevna.stop()`, and at normal
  interpreter exit. A recording cut short by a crash has no footer and stays
  readable up to its last full line; the reader reports it as a missing footer.
- `open_recording()` raises `RecordingError` for a file it cannot use. Its
  `type` is one of the Node loader's error types (`empty-file`,
  `invalid-json`, `invalid-record-shape`, `unsupported-format-version`,
  `unsupported-protocol-version`, `io-error`). The Node SDK returns these as
  values instead of raising; this is the same information in the idiom of each
  language.
- Events are written by a background thread through a queue limited to 10,000
  events. In a local measurement it sustained 50,000 events per second with no
  drops. If the disk cannot keep up, events are dropped, counted, and one
  warning is logged, and the footer's count matches what was written. A stuck
  disk therefore costs bounded memory, not a growing queue.
- Recording stores what the instrumentation already recorded, so the same
  boundaries hold: no SQL parameters, no Redis arguments, no headers or bodies.
- A forked worker (gunicorn, `uvicorn --workers`) does not write to the
  recording its parent started. It drops its events and logs one warning, the
  same as the dashboard does.
- Numbers that are not finite (`NaN`, infinity) are written as `null`, as
  `JSON.stringify` does. Python's default writes them as bare tokens, which are
  not JSON and which the dashboard and the Node loader reject.

### Known gaps

- **Redis pipelines are not captured.** A pipeline sends through its own object
  rather than the client's `execute_command`. Reporting a batch as one
  misleading event would be worse than reporting nothing, so nothing is
  reported. There is a test that fails if this ever changes silently.
- **Raw `asyncpg` is not instrumented.** SQLAlchemy over asyncpg is, which
  covers most of it.
- **`requests` is not instrumented.** `httpx` is.

## What's next

| | |
| --- | --- |
| WSGI (Flask, Django) | planned |
| Raw `asyncpg`, `requests`, Redis pipelines | unscheduled |

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
