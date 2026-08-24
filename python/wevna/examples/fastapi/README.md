# Wevna + FastAPI

A runnable FastAPI app with Wevna watching it.

## Run it

From the repository root:

```bash
pnpm install
pnpm build
pnpm --filter @wevna/python example
```

Then open **<http://localhost:4123>** and, in another terminal:

```bash
curl http://localhost:8000/orders/42   # the interesting one
curl http://localhost:8000/health
curl http://localhost:8000/boom        # raises on purpose
```

No database, no Redis, no containers.

## What you should see

`GET /orders/42` produces a request with fourteen events in it — logs, an
`"Orders"` lookup, a Redis `get`, a `"Customers"` lookup, **four identical
queries against `"OrderItems"`** (an N+1), an outgoing HTTP call, and a Redis
`set`.

Open the request and switch to the **Performance** tab:

```
Repeated Query
The same query ran 4 times, taking 155ms in total:
select * from "orderitems" where "orderid" = :id
```

Two things worth noticing there. The `:id` is SQLAlchemy's parameter style
rather than Postgres' `$1`, and the detector handled it without knowing which
language produced it. And the table and column names survived, so the finding
tells you *where* to look — while the value is still replaced, so an
interpolated literal cannot reach the dashboard through the signature.

`GET /boom` raises, and the exception is attached to the request that caused
it rather than floating loose in a log.

## The setup, in full

```python
import wevna
from wevna.asgi import WevnaMiddleware
from wevna.httpx import instrument as instrument_httpx
from wevna.redis import instrument as instrument_redis
from wevna.sqlalchemy import instrument as instrument_sqlalchemy

wevna.start()

app = FastAPI()
app.add_middleware(WevnaMiddleware)

instrument_sqlalchemy(engine)
instrument_redis(cache)
instrument_httpx(upstream)
```

That's everything. [`app.py`](app.py) is otherwise an ordinary FastAPI app —
nothing below the setup block is Wevna-aware, and no handler passes a context
object anywhere.

## Nothing here is stubbed

Every integration in this example is the real one:

- **SQLAlchemy** — a real async engine over a real `aiosqlite` driver
- **redis-py** — a real client, with `fakeredis` providing the server in memory
- **httpx** — a real client calling a real local API

What is substituted is only the *server* on the other end, which is why this
runs with no database, no Redis and no network. The instrumentation, the
correlation and the timings are all genuine.

That also means the capture boundaries you see here are the real ones:

- **SQL records statement text and a duration, never the bound parameters.**
  Note that the dashboard shows `where id = ?` — the value never left your
  process.
- **Redis records only the command name.** Commands carry the value inline —
  `SET session:abc <token>` — so unlike parameterised SQL there is no safe
  subset of the arguments to keep.
- **The outgoing call's `api_key` is redacted** before it reaches the
  dashboard, while the path and the other query parameters survive.

## See also

- [The Python SDK](../../README.md)
- [The root README](../../../../README.md) — everything Wevna does
- [STABILITY.md](../../../../STABILITY.md) — what's guaranteed, and what isn't
