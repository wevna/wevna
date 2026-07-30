# Wevna + NestJS

How to run Wevna alongside a NestJS application.

> **Status:** this package documents the integration pattern; it doesn't
> contain a runnable demo app yet. The code below works today against the
> real `wevna` package — see [the root README](../../README.md) for what's
> actually implemented.

## Setup

```ts
// main.ts
import { NestFactory } from "@nestjs/core";
import { wevna, WevnaNestInterceptor } from "wevna";
import { AppModule } from "./app.module";

await wevna.start();

const app = await NestFactory.create(AppModule);
app.useGlobalInterceptors(new WevnaNestInterceptor());
await app.listen(3000);
```

Every request is captured with no setup at all — Nest's HTTP layer is
Express or Fastify underneath, and Wevna's HTTP instrumentation sits below
both. `app.useGlobalInterceptors(new WevnaNestInterceptor())` is only for
**enrichment**: it adds the controller and handler method name (e.g.
`WidgetsController.getWidget`) to the `http.request` event.

## Why the route still shows up without it

Nest dispatches through whichever underlying adapter you're using
(Express by default, or Fastify), and that adapter's own route data is
what the base instrumentation — or, for Fastify,
[`wevnaFastifyEnrichment`](../fastify/README.md) — already reads.
`WevnaNestInterceptor` adds Nest-specific detail (controller/handler
names) on top; it doesn't replace that.

## What you'll see

Open the dashboard Wevna prints (`http://localhost:4123` by default) and
hit an endpoint. You'll see, correlated to that one request:

- the `http.request` event — method, route, status, duration, and (with
  the interceptor registered) which controller/handler served it
- any logging done while handling it
- any instrumented `pg`/`ioredis` calls made while handling it (see the
  root README for wiring those up)

all grouped together and laid out on that request's waterfall.
