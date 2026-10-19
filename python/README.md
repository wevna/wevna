# wevna (Python)

See what your Python backend is actually doing: every request, SQL query,
Redis command, outgoing HTTP call and log line, grouped under the request that
caused it, in a live dashboard on your machine. The Python counterpart of
[`@wevna/sdk`](https://github.com/wevna/wevna).

No agent, no account, nothing leaves your machine. Zero dependencies.

## How it fits together

The dashboard is the Node one. Your Python process sends events to it over
`localhost`:

```bash
npx @wevna/sdk            # starts the dashboard at http://localhost:4123
```

```bash
pip install wevna
```

## FastAPI / Starlette / any ASGI app

```python
import wevna
from wevna.asgi import WevnaMiddleware

wevna.start()
app = WevnaMiddleware(app)
```

## Flask

```python
import wevna
import wevna.flask

wevna.start()
wevna.flask.install(app)   # also records the route pattern, /orders/<int:id>
```

## Django, or any other WSGI app

```python
# wsgi.py
from wevna.wsgi import WevnaWSGIMiddleware
application = WevnaWSGIMiddleware(get_wsgi_application())

# settings.py — records the route pattern (articles/<int:pk>/), not the URL
MIDDLEWARE = ["wevna.django.WevnaDjangoMiddleware", ...]
```

(Django's ASGI entry point works with `WevnaMiddleware` the same way.)

## What `wevna.start()` captures

| You get | How |
| --- | --- |
| Requests (`http.request`) | the middleware above |
| Outgoing HTTP (`http.client`) | `requests` and `httpx`, sync and async, if installed |
| Redis (`redis.command`) | `redis-py`, sync and asyncio, if installed |
| SQL (`sql.query`) | `instrument_sqlalchemy(engine)` or `instrument_connection(conn)` |
| Logs (`console.log`) | the standard `logging` module |
| Exceptions (`exception.captured`) | raised out of a request |

SQL is explicit, because DB-API connections are C types that can't be patched:

```python
import sqlite3
conn = wevna.instrument_connection(sqlite3.connect("app.db"))   # or psycopg, psycopg2, ...
```

SQLAlchemy has its own hook and sees ORM and Core alike (sync and async engines):

```python
wevna.instrument_sqlalchemy(engine)
```

Anything not installed is skipped silently. `wevna.start(instrument=False)`
turns the automatic part off.

## What it never records

The same rules as the Node SDK, deliberately:

- **SQL parameters** — only the statement text is read, never the values.
- **Redis arguments** — only the command name.
- **Request and response bodies and headers.**
- **Secrets in outgoing URLs** — `user:pass@` is dropped and the values of
  `token`, `api_key`, `password`, `signature` and similar query parameters are
  replaced (same rules as `@wevna/plugin-fetch`).

## It cannot hurt your app

Events go into a bounded in-memory queue and are sent by a background thread.
If the dashboard isn't running, they are dropped with a single warning; nothing
raises into your code, and nothing waits on the network.

## Configuration

`wevna.start(url=...)`, or the `WEVNA_URL` environment variable. Default
`http://localhost:4123`. Start the dashboard on another port with
`npx @wevna/sdk --port 5000`.

## Status

`0.1.0`, pre-release. Python 3.9+. Typed (`py.typed`).
