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

`GET /orders/42` produces a request with twelve events in it — logs, an
`"Orders"` lookup, a Redis `get`, a `"Customers"` lookup, and **four identical
queries against `"OrderItems"`**, which is an N+1.

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

wevna.start()

app = FastAPI()
app.add_middleware(WevnaMiddleware)
```

That's everything. [`app.py`](app.py) is otherwise an ordinary FastAPI app —
nothing below the setup block is Wevna-aware, and no handler passes a context
object anywhere.

## About the fake clients

[`fake_clients.py`](fake_clients.py) stands in for a database and a cache so
this example needs no services running.

Phase 2 will instrument SQLAlchemy and `redis-py` directly. Until then these
publish `sql.query` and `redis.command` events through the same path those
integrations will use, so the dashboard shows exactly what it will show for
the real thing. What is fake is the storage; what is real is the event stream,
the correlation and the timing.

They also hold the same capture boundaries the real integrations will:

- **SQL records the query text and a duration, never the bound parameters.**
  Parameterised query text normally contains no data, and the values are
  exactly where the secrets are.
- **Redis records only the command name.** Commands routinely carry the value
  inline — `SET session:abc <token>` — so unlike parameterised SQL there is no
  safe subset of the arguments to keep.

## See also

- [The Python SDK](../../README.md)
- [The root README](../../../../README.md) — everything Wevna does
- [STABILITY.md](../../../../STABILITY.md) — what's guaranteed, and what isn't
