# Wevna

**A local-first runtime dashboard for backend developers.**

Wevna watches your Node.js backend run — every HTTP request, SQL query,
Redis command, and `console.log` — and streams it live to a dashboard in
your browser, correlated back into the request it belongs to.

> **Status:** pre-release, under active development. The core is working
> and self-hosted — this README describes what actually runs today, not a
> roadmap dressed up as a feature list. APIs may still change before 1.0.

## Why

Backend debugging today usually looks like one of two things:

```
console.log(...)
console.log(...)
console.log(...)
```

or

```
tail -f app.log
```

Both work. Neither shows you what's actually happening — which query ran
for which request, how long it took, what fired before or after it. You
reconstruct that by hand, every time.

Wevna doesn't replace your logs. It gives you a live, structured view of
runtime behavior sitting next to them: instead of reading logs, watch your
backend execute.

## Demo

<!--
  TODO: record and embed a short GIF here of the live dashboard — a
  request coming in, its console/SQL/Redis events streaming into the
  event list, and the resulting request row expanding into its waterfall.
  A still screenshot undersells this; the point is watching it happen
  live. See `packages/dashboard` for the UI this would capture.
-->

_A demo GIF belongs here — coming soon._

## Installation

```bash
npm install wevna
```

```ts
import { wevna } from "wevna";

await wevna.start();
```

That's it. Wevna starts a local dashboard at `http://localhost:4123` and
begins capturing `console.log`, HTTP requests, and (once you opt in) your
database traffic — all from that one call, no config file, no agent to
deploy.

To instrument PostgreSQL or Redis, pass Wevna your existing client once,
anywhere in your app's startup:

```ts
import { Pool } from "pg";
import Redis from "ioredis";
import { wevna } from "wevna";

await wevna.start();

const pool = new Pool();
wevna.instrumentPg(pool);

const redis = new Redis();
wevna.instrumentRedis(redis);
```

Everything you already do with `pool`/`redis` keeps working exactly the
same — Wevna only observes.

## Features

What's actually implemented and running, today:

- ✅ **Live runtime dashboard** — a local web UI, no account, no cloud
- ✅ **HTTP requests** — framework-agnostic; works under Express, Fastify,
  and NestJS with no code changes
- ✅ **PostgreSQL** (`pg`) — query text, duration, row count
- ✅ **Redis** (`ioredis`) — command name and duration
- ✅ **Console** — every `console.log`, correlated to the request it
  happened during
- ✅ **Request correlation** — every event from the same request shares
  one identifier, automatically, via `AsyncLocalStorage`
- ✅ **Request Inspector** — select a request to see its full summary,
  waterfall, and events in one place, DevTools-Network-panel style
- ✅ **Waterfall timeline** — each request's events laid out visually,
  proportional to when they happened and how long they took
- ✅ **Exception capture** — uncaught errors and rejections, correlated to
  the request that produced them, with type/message/stack trace
- ✅ **Performance intelligence** — deterministic per-request analysis
  (longest operation, SQL/Redis time, event counts) and insights like
  "Slow Request" or "Multiple Database Calls", with the numbers behind them
- ✅ **Search, filtering, pause/resume/clear** — on the live event stream,
  entirely client-side

Framework-specific route/handler enrichment is available for
[Fastify](examples/fastify/README.md) and [NestJS](examples/nest/README.md)
as an explicit opt-in; Express gets it automatically.

## Architecture

```
Application
     │
     ▼
    SDK
     │
     ▼
  Runtime
     │
     ▼
 WebSocket
     │
     ▼
 Dashboard
```

Your application code never talks to the dashboard directly. The SDK
instruments your app in-process, the Runtime turns what it observes into a
structured protocol event and publishes it, and the dashboard receives it
live over a WebSocket the Runtime's local server hosts alongside your app.
Nothing leaves your machine.

## Roadmap

**Completed**

- ✔ Protocol & runtime
- ✔ Console, HTTP, PostgreSQL, and Redis instrumentation
- ✔ Framework enrichment (Express, Fastify, NestJS)
- ✔ Live dashboard (search, filter, pause/resume/clear)
- ✔ Request correlation
- ✔ Request model
- ✔ Timeline model
- ✔ Waterfall view
- ✔ Request Inspector
- ✔ Exception capture & inspector
- ✔ Performance intelligence

**Next**

- Replay
- More instrumentation targets (BullMQ, Prisma, MongoDB)

## Packages

This is a pnpm monorepo. The published `wevna` package (`packages/sdk`) is
the only one you install; everything else supports it:

| Package               | What it is                                      |
| ---------------------- | ------------------------------------------------ |
| `packages/sdk`         | The `wevna` package — public API, Runtime, instrumentation |
| `packages/protocol`    | The shared event/envelope types every other package agrees on |
| `packages/server`      | The local Fastify server + WebSocket transport the SDK starts |
| `packages/dashboard`   | The React dashboard UI, served by the local server |
| `packages/intelligence`| Deterministic request performance analysis — no React, no Fastify, reusable outside the dashboard |
| `packages/shared`      | Reserved for cross-cutting utilities; currently a placeholder |

## Contributing / running locally

```bash
git clone https://github.com/wevna/wevna.git
cd wevna
pnpm install
pnpm build
pnpm test
```

Requires Node 22+ and pnpm. See [examples/](examples/) for integration
patterns with specific frameworks.

## License

[MIT](LICENSE)
