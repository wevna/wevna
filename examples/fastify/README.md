# Wevna + Fastify

How to run Wevna alongside a Fastify application.

> **Status:** this package documents the integration pattern; it doesn't
> contain a runnable demo app yet. The code below works today against the
> real `wevna` package — see [the root README](../../README.md) for what's
> actually implemented.

## Setup

```ts
import Fastify from "fastify";
import { wevna, wevnaFastifyEnrichment } from "wevna";

await wevna.start();

const app = Fastify();
await app.register(wevnaFastifyEnrichment);

app.get("/widgets/:id", async (request) => {
  request.log.info({ id: request.params.id }, "fetching widget");
  return { id: request.params.id };
});

await app.listen({ port: 3000 });
```

Every request Fastify handles is captured with no setup at all — Wevna's
HTTP instrumentation observes Node's raw `http.Server`, one layer below
Fastify. The one extra line, `app.register(wevnaFastifyEnrichment)`, is
only for **route enrichment**.

## Why Fastify needs that one extra line

Express mutates the same request object Wevna already observes, so its
route data is readable directly. Fastify wraps the raw request in its own
object instead, so there's nothing to read after the fact — enrichment
needs a hook that runs while Fastify still has that context.
`wevnaFastifyEnrichment` is that hook: register it once, and the matched
route pattern (`/widgets/:id`) and handler name show up on the
`http.request` event in the dashboard.

Skip it and Wevna still captures every request — you'll just see the raw
URL instead of the route pattern.

## What you'll see

Open the dashboard Wevna prints (`http://localhost:4123` by default) and
hit an endpoint. You'll see, correlated to that one request:

- the `http.request` event — method, route, status, duration
- any logging done while handling it
- any instrumented `pg`/`ioredis` calls made while handling it (see the
  root README for wiring those up)

all grouped together and laid out on that request's waterfall.
