# Wevna + Express

A runnable Express app, instrumented with Wevna.

## Run it

```bash
git clone https://github.com/wevna/wevna.git
cd wevna
pnpm install
pnpm build
pnpm --filter @wevna/example-express dev
```

Then open **<http://localhost:4123>** and, in another terminal:

```bash
curl http://localhost:3000/orders/42   # the interesting one
curl http://localhost:3000/health
curl http://localhost:3000/boom        # throws on purpose
```

No database, no Redis, no containers. See [below](#about-the-fake-clients) for
why that works and what it does *not* fake.

## What you should see

`GET /orders/42` produces a request with thirteen events in it:

- a couple of `console.log` lines
- a lookup on `"Orders"`, then one on `"Customers"`
- a Redis `get`
- **four identical queries against `"OrderItems"`** — one per item, which is
  an N+1
- an outgoing `fetch` to a local stand-in API
- a Redis `set`

Open the request and switch to the **Performance** tab. Wevna reports:

```
Repeated Query
The same query ran 4 times, taking 198ms in total:
select * from "orderitems" where "orderid" = ?
```

The table and column survive so the finding is actionable; the *value* is
replaced, so an interpolated literal can never reach the dashboard through
the signature.

`GET /boom` throws, and the exception is attached to the request that caused
it rather than floating loose in a log.

## The setup, in full

```ts
import { createFetchPlugin } from "@wevna/plugin-fetch";
import { wevna, wevnaExpressErrorHandler } from "@wevna/sdk";

wevna.use(createFetchPlugin());
await wevna.start();

wevna.instrumentPg(pool);
wevna.instrumentRedis(redis);

// ... your ordinary Express app ...

app.use(wevnaExpressErrorHandler);  // last, after all routes
```

That's everything. [`src/app.ts`](src/app.ts) is otherwise a plain Express
app — nothing below the setup block is Wevna-aware.

## Why so little is needed

Requests, routes and `console.log` need nothing beyond `wevna.start()`.
Wevna patches `http.Server.prototype.emit` and `console.log` once, and
correlates everything through `AsyncLocalStorage`, so your handlers never
have to pass a context around.

`pg` and `ioredis` are opt-in because there's no global hook for "every pool
anyone ever creates" — you hand Wevna the client you already made.

`wevnaExpressErrorHandler` is the one addition, and only for exceptions.
Express swallows handler errors into its own error pipeline, which is not
something Wevna can patch from the outside, so it needs a normal error
middleware registered after your routes. It only observes and always calls
`next(err)`, so it never changes what response Express sends.

## About the fake clients

[`src/fake-clients.ts`](src/fake-clients.ts) stands in for `pg.Pool` and
`ioredis` so this example runs with nothing installed.

They are **not** mocks of Wevna. Wevna's instrumentation interfaces are
structural on purpose — `PgQueryable` needs only `query()`, and
`RedisSendCommandLike` only `sendCommand()` — precisely so a real client
satisfies them without Wevna depending on `pg` or `ioredis`. These objects
satisfy the same interfaces, so they travel the identical code path a real
client does. Only the storage is fake; every event in the dashboard was
produced by the real instrumentation.

To point it at a real database, swap two lines:

```ts
const pool = new Pool();          // instead of createPool()
const redis = new Redis();        // instead of createRedis()
```

Nothing else in `app.ts` changes.

## See also

- [Root README](../../README.md) — everything Wevna does
- [`@wevna/plugin-fetch`](../../packages/plugin-fetch/README.md) — outgoing
  HTTP capture and its redaction rules
- [STABILITY.md](../../STABILITY.md) — what's guaranteed, and what isn't
