# Wevna + Express

How to run Wevna alongside a plain Express application.

> **Status:** this package documents the integration pattern; it doesn't
> contain a runnable demo app yet. The code below works today against the
> real `wevna` package — see [the root README](../../README.md) for what's
> actually implemented.

## Setup

```ts
import express from "express";
import { wevna } from "wevna";

await wevna.start();

const app = express();

app.get("/widgets/:id", (req, res) => {
  console.log("fetching widget", req.params.id);
  res.json({ id: req.params.id });
});

app.listen(3000);
```

That's the whole integration. No middleware, no route wrapping.

## Why nothing else is needed

Wevna's HTTP instrumentation observes Node's raw `http.Server`, one layer
below Express — so every request Express handles is captured
automatically, regardless of when `wevna.start()` runs relative to
`app.listen()`.

Express also gets **automatic route enrichment**: because Express mutates
the same request object Wevna already observes, the matched route pattern
(e.g. `/widgets/:id`, not just the raw URL) and the name of the handler
function that served it show up in the dashboard with no extra
configuration. This is the one framework where enrichment needs no setup
at all — see [Fastify](../fastify/README.md) and [NestJS](../nest/README.md)
for the frameworks that do.

## What you'll see

Open the dashboard Wevna prints (`http://localhost:4123` by default) and
hit an endpoint. You'll see, correlated to that one request:

- the `http.request` event itself — method, route, status, duration
- any `console.log` calls made while handling it
- any instrumented `pg`/`ioredis` calls made while handling it (see the
  root README for wiring those up)

all grouped together and laid out on that request's waterfall.
