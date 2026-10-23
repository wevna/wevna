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
| **HTTP requests** via WSGI middleware | Flask, Django, and anything WSGI |
| **Per-request correlation** via `contextvars` | automatic; handlers pass nothing |
| **`logging` capture** | levels, logger names, exceptions |
| **Uncaught exceptions** | attached to the request that caused them |
| **The dashboard** | served from your process, on its own thread |
| **SQLAlchemy** | sync and async engines, ORM and Core alike |
| **redis-py** | sync and async clients |
| **Outgoing HTTP** | `httpx`, sync and async, with URL redaction |

Install only what you use:

```bash
pip install "wevna[sqlalchemy,redis,httpx,flask,django]"
```

Each integration is an optional extra. Instrumentation for a library you don't
use shouldn't make you install it.

### Flask, Django and other WSGI apps

```python
from wevna.wsgi import WevnaMiddleware
import wevna.flask

wevna.start()
app.wsgi_app = WevnaMiddleware(app.wsgi_app)  # Flask
wevna.flask.instrument(app)  # the route pattern, and unhandled exceptions
```

```python
# Django: wsgi.py
application = WevnaMiddleware(get_wsgi_application())

# settings.py
MIDDLEWARE = ["wevna.django.WevnaDjangoMiddleware", ...]
```

`WevnaMiddleware` works on its own for any WSGI app and records
`http.request` with method, path, status and duration, plus an
`exception.captured` if the application raises. The Flask and Django hooks add
what only those frameworks know, and are a few lines each:

- **The route pattern** (`/orders/<int:order_id>`), so requests to one endpoint
  group as one. WSGI has no notion of a route, so the framework hook writes it
  into the `environ` dict, which the middleware and the framework share. Without
  a hook the request is still recorded, with its path and no route.
- **Exceptions the framework turns into a 500.** Flask and Django catch an
  unhandled exception and return an error page, so the WSGI layer never sees it
  raised. The hooks report it, as `framework: "flask"` or `"django"`. A
  deliberate `abort(404)` is not an exception and is not reported.

Two properties worth knowing, because WSGI makes them easy to get wrong:

- **Streamed responses stay correlated.** The server pulls a WSGI response body
  after the application has returned, so a generator that runs queries while
  streaming is still running application code. Each request, and every step of
  its body, runs in a context of its own, so that work belongs to its request
  even when one thread is partway through several responses. The
  `http.request` event is published when the response ends (read to the end, or
  closed), so its duration includes the streaming.
- **`close()` is honoured.** If the application's response has a `close()`, it is
  called exactly once, even if the server never read the body.

The query string is not recorded, the same as for ASGI. Django under ASGI has no
shared `environ`, so use `wevna.asgi.WevnaMiddleware` there. Under Django's
WSGI handler the route is recorded.

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

One boundary to know about: the redaction above applies to what Wevna records
itself. `logging` capture records what *your* loggers write, and some libraries
log full URLs. `httpx` logs `HTTP Request: GET <url>` at INFO, and Werkzeug's
access log writes the request line, both with the query string. An `api_key` in
that URL is redacted in the `http.client` event and still present in the log
message. Quiet those loggers (`logging.getLogger("httpx").setLevel(logging.WARNING)`)
or keep secrets out of URLs. The Flask example does the former.

These are the Node SDK's boundaries, not new ones. A Python event stream that
captured more than its Node counterpart would make the protocol a lie, and the
[URL redaction rules](../../packages/plugin-fetch/fixtures/sanitize-url.json)
are literally the same fixture both languages test against.

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
