# Wevna

**A local-first runtime dashboard for backend developers.**

Wevna watches your Node.js backend run — every HTTP request, SQL query,
Redis command, and `console.log` — and streams it live to a dashboard in
your browser, correlated back into the request it belongs to.

> **Status:** 1.0. This README describes what actually runs today, not a
> roadmap dressed up as a feature list. See [STABILITY.md](STABILITY.md) for
> exactly what is covered by semver, what the frozen protocol and plugin api
> guarantee, and what is deliberately *not* guaranteed.

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

## What you actually see

Start your app, open `http://localhost:4123`, and hit an endpoint. The
dashboard fills in live:

```
GET /orders/42                                      200 · 187ms

  Waterfall
  0ms                    93ms                    187ms
  http.request  ██████████████████████████████████████
  sql.query          ████████████
  redis.command                  ██
  console.log                        •
  sql.query                            ██████████████

  Where the time went
  sql              161ms · 86.1%   ████████████████████
  redis              2ms ·  1.1%   ▏

  Insights
  Repeated Query    The same query ran 4 times, taking 158ms in total:
                    select * from order_items where order_id = ?
  Where The Time    86.1% of this request (161ms) was spent on PostgreSQL.
  Went

  Execution graph
  http.request                    ████████████████████   187ms
  ├ sql.query                        ███                    3ms
  ├ redis.command                        ▪                   2ms
  │ └ console.log                        •                     —
  └ sql.query                              ████████████    158ms
```

That's the whole idea: a request came in, and you can see *what it did*, in
order, with the slow part named — instead of reconstructing it from log lines.

## Install

```bash
npm install wevna     # pnpm add wevna · yarn add wevna
```

Requires **Node 22+**. Wevna is a `devDependency` in spirit — it's a debugging
tool, not something you run in production. Nothing stops you, but see
[Should I run this in production?](#should-i-run-this-in-production) first.

## Quick start

One call. Put it as early in your startup as you can:

```ts
import { wevna } from "wevna";

await wevna.start();
```

That's the whole setup. You now have:

- A dashboard at **`http://localhost:4123`**
- Every `console.log` captured
- Every HTTP request your app serves captured, with method, route, status and
  duration
- Every uncaught exception and unhandled rejection captured, attached to the
  request that produced it
- All of it **correlated** — events from one request are grouped under that
  request automatically

No config file, no agent, no account, no network egress.

### Options

```ts
await wevna.start({
  port: 4123,        // default; use 0 to let the OS pick a free port
  host: "localhost", // default; the dashboard is not reachable off-machine
});
```

## Adding your database and cache

There's no global "every `pg.Pool`" hook to patch, so these are opt-in: hand
Wevna the client you already created, once.

```ts
import { Pool } from "pg";
import Redis from "ioredis";
import { wevna } from "wevna";

await wevna.start();

const pool = new Pool();
wevna.instrumentPg(pool);      // → sql.query events

const redis = new Redis();
wevna.instrumentRedis(redis);  // → redis.command events
```

Everything you already do with `pool` / `redis` keeps working **identically**.
Wevna wraps the method, times the call, and passes the result straight through.
Order doesn't matter — call these before or after `start()`.

**What gets recorded, and what doesn't:**

| | Recorded | Not recorded |
| --- | --- | --- |
| PostgreSQL | Query text, duration, row count | Parameter **values** (`args[1]` is never read) |
| Redis | Command name, duration | Command arguments or results |

Redis arguments are never captured because commands routinely carry the value
inline (`SET session:abc <token>`) — unlike parameterized SQL, there's no safe
subset to keep.

## Outgoing HTTP

A request that spends 400ms waiting on a third-party API looks identical to a
slow handler until you can see the call.

```bash
npm install @wevna/plugin-fetch
```

```ts
import { wevna } from "wevna";
import { createFetchPlugin } from "@wevna/plugin-fetch";

wevna.use(createFetchPlugin());
await wevna.start();
```

Every `fetch()` now appears in the waterfall of the request that triggered it,
and is eligible to be named as that request's slowest operation.

```ts
// Keep a chatty internal dependency out of the stream:
wevna.use(createFetchPlugin({ ignoreHosts: ["metrics.internal"] }));
```

URLs are sanitized before being recorded: userinfo stripped, sensitive-looking
query parameter *values* redacted, everything else kept. Headers and bodies are
**never** recorded. See [the plugin's README](packages/plugin-fetch/README.md)
for the exact redaction rules — and note they're a conservative default, not a
guarantee.

## Framework setup

| Framework | What you need to do |
| --- | --- |
| **Express** | Nothing. Route and handler enrichment is automatic. |
| **Fastify** | Register one plugin (below) for route names. |
| **NestJS** | Register one interceptor (below) for route/handler names. |

HTTP capture itself is framework-agnostic and needs no wiring anywhere — these
only add richer route/handler attributes.

**Express** — nothing required, but add the error handler *last* to capture
handler exceptions (Express has no hook Wevna can patch for this):

```ts
import express from "express";
import { wevna, wevnaExpressErrorHandler } from "wevna";

await wevna.start();
const app = express();

// ... your routes ...

app.use(wevnaExpressErrorHandler());  // last, after all routes
```

**Fastify:**

```ts
import Fastify from "fastify";
import { wevna, wevnaFastifyEnrichment } from "wevna";

await wevna.start();
const app = Fastify();
await app.register(wevnaFastifyEnrichment);
```

**NestJS:**

```ts
import { WevnaNestInterceptor } from "wevna";

app.useGlobalInterceptors(new WevnaNestInterceptor());
```

Runnable versions of all three live in [examples/](examples/).

## Reading the dashboard

The **Request Inspector** is the primary view — think Chrome's Network panel.
Pick a request from the list and you get five things:

**Summary** — method, route, status, duration, and counts per event kind.

**Waterfall** — every event laid out proportionally. A bar *ends* at the moment
the operation finished and extends backward by its duration, so bar length is
real time spent. Zero-duration events (a `console.log`) render as markers, not
bars.

**Where the time went** — per-category totals and share of the request. This is
what turns "842ms" into "601ms of it was PostgreSQL". Shares can sum past 100%
for genuinely concurrent work — that's reported rather than normalized away,
because inventing a serialization the runtime never had would be worse.

**Insights** — threshold-based findings, each stating the numbers behind it:

| Insight | Fires when |
| --- | --- |
| Slow Request | Total duration > 1000ms |
| Long SQL Execution | Any single query > 100ms |
| Multiple Database Calls | More than 5 queries |
| Multiple Redis Operations | More than 5 commands |
| **Repeated Query / Redis Command** | The same operation ran ≥ 3 times |
| Where The Time Went | One category took > 60% of the request |
| Exception Occurred | Any exception was captured |

Repeated-operation detection normalizes query *shape*, so a loop interpolating
`id = 1`, `id = 2`, `id = 3` is recognized as one repeated query — the
observable signature of an N+1. It reports rather than diagnoses: a repeated
query is often an N+1 and sometimes entirely correct.

**Execution graph** — the same events as a dependency tree, nested by what ran
*inside* what. Nesting is derived from timing containment, the way a flame chart
works. It means "this ran during that" — **not** "this caused that", because
nothing Wevna observes could establish causality.

Above the request list you also get live **search**, **kind filtering**, and
**pause / resume / clear** — all client-side, so pausing never loses events
still arriving.

## Recording and replay

Record the live stream to a portable file:

```ts
await wevna.startRecording("./session.jsonl");
// ... your app runs; the dashboard behaves exactly as before ...
await wevna.stopRecording();
```

It's JSON Lines — a header, one line per event, then a footer — so it's safe to
`tail -f` or pipe through `jq` while it's still being written, and a recording
cut short by a crash is still valid up to its last complete line.

Open it later, with no running application:

```ts
import { openRecording } from "wevna";

const result = await openRecording("./session.jsonl");
if (result.ok) {
  console.log(`Dashboard running at ${result.recording.url}`);
  // ... await result.recording.close() when done
} else {
  console.error(result.error);  // structured, never thrown
}
```

You get the same dashboard plus a transport bar: **Restart**, **Step
Back/Forward**, **Play/Pause**, a **seek slider**, and **0.25x–8x** speed.
Playback preserves the recording's own relative timing. Every feature —
inspector, waterfall, insights, graph, exceptions, search — works at whatever
position you're scrubbed to, because from the dashboard's point of view it *is*
live, just backed by a file with a position you control instead of "now".

A freshly opened recording starts **fully played**, so opening one shows you
everything immediately rather than an empty screen you have to press play on.

## API reference

| Call | Does |
| --- | --- |
| `wevna.start(options?)` | Starts the runtime and dashboard. Idempotent. |
| `wevna.stop()` | Stops everything, tears down plugins, finalizes any recording. |
| `wevna.instrumentPg(client)` | Observe a `pg` Pool/Client. Safe to call twice. |
| `wevna.instrumentRedis(client)` | Observe an `ioredis` client. |
| `wevna.use(plugin)` | Register a plugin. **Never throws.** |
| `wevna.plugins` | Every registered plugin and its status. |
| `wevna.pluginsSettled()` | Resolves once no plugin setup is in flight. |
| `wevna.startRecording(path)` | Begin recording to a JSONL file. |
| `wevna.stopRecording()` | Finalize and close the recording. |
| `wevna.isRecording` | Whether a recording is active. |
| `openRecording(path, options?)` | Serve a recording offline. Returns a result, never throws. |
| `SessionLoader` | Read a recording programmatically, without a dashboard. |

## Should I run this in production?

Wevna is built to be safe in a live process — it never changes what your code
does, never throws into your code path, and sends nothing off your machine. But
it's designed for **development and staging**, and two things are worth knowing
before you reach for it in production:

- It registers process-level `uncaughtException` / `unhandledRejection`
  listeners, which changes Node's default crash behaviour.
- It holds recent history in memory (bounded — 10,000 events / 1,000 requests)
  and serves an unauthenticated dashboard on localhost.

[STABILITY.md](STABILITY.md) spells out every guarantee and non-guarantee.

## Troubleshooting

**Dashboard is empty.** Have you actually sent a request? Startup logs before
`wevna.start()` resolves aren't captured. Check the port isn't already taken —
`start({ port: 0 })` will pick a free one and log it.

**No SQL or Redis events.** These need `instrumentPg()` / `instrumentRedis()`
with the *same* client instance your code queries through. A pool created after
the call, or a second pool, isn't instrumented. Only Promise-returning `pg`
calls are observed — callback-style calls pass through unobserved rather than
being guessed at.

**No events from my plugin.** Check `wevna.plugins`: a plugin with status
`failed` has an `error` explaining why. Wrong `apiVersion` and duplicate names
are reported there rather than thrown.

**Events aren't grouped under a request.** Correlation uses
`AsyncLocalStorage`. Work that escapes the request's async context — something
queued to a `setInterval`, or a detached promise — genuinely isn't part of that
request and is reported uncorrelated rather than guessed at.

**Older events disappeared.** Expected: the dashboard retains the most recent
10,000 events and 1,000 requests. Record the session if you need more.

## Writing a plugin

Anything Wevna doesn't instrument itself can be added as a plugin, without
touching Wevna's core:

```ts
import { PLUGIN_API_VERSION, wevna, type WevnaPlugin } from "wevna";

const myPlugin: WevnaPlugin = {
  name: "wevna-plugin-acme",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  // Optional, declarative — lets tooling answer "what can this runtime
  // produce" before a single event has been produced.
  eventKinds: ["acme.call"],

  setup(context) {
    const original = acmeClient.call;
    acmeClient.call = async (...args) => {
      const startedAt = performance.now();
      try {
        return await original.apply(acmeClient, args);
      } finally {
        context.publish({
          kind: "acme.call",
          attributes: { durationMs: performance.now() - startedAt },
        });
      }
    };
    // Optional: undo it when Wevna stops.
    return () => {
      acmeClient.call = original;
    };
  },
};

wevna.use(myPlugin);
await wevna.start();
```

`context.publish()` stamps the event id, timestamp, source plugin, and the
active request correlation for you, so a plugin's events land in the
waterfall, performance insights, execution graph, and replay exactly like a
built-in producer's — no dashboard changes required.

`wevna.use()` works before or after `start()`, and **never throws**: a plugin
Wevna can't use (wrong `apiVersion`, duplicate name, a `setup()` that
throws) is quarantined and reported through `wevna.plugins` rather than
breaking your application's startup.

```ts
console.table(wevna.plugins);
// name                 version  apiVersion  status   error
// wevna:pg             1.0.0    1           active
// wevna:redis          1.0.0    1           active
// wevna-plugin-acme    1.0.0    1           active
```

Wevna's own PostgreSQL and Redis instrumentation are in that list because
they genuinely are plugins — `instrumentPg()`/`instrumentRedis()` are
convenience wrappers over the same public api your plugin uses. A plugin
system whose own built-ins bypass it is how extension points rot: if the
shipped instrumentation can't be written against the documented surface, a
community plugin won't manage it either.

A note on what that protection is and isn't: plugins run **in your process,
with full access to it**, because instrumentation works by wrapping your
actual client objects — a sandbox would put a boundary between a plugin and
the very things it exists to observe. What Wevna guarantees is *fault*
isolation: a plugin's failures stay the plugin's own and never reach your
application. Plugins are code you install and trust, exactly like any other
dependency.

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
- ✅ **Where the time went** — per-category time attribution, so a request's
  duration comes with "601ms of it was PostgreSQL" instead of just a number
- ✅ **Repeated-operation detection** — the same query shape run N times in
  one request, normalized so interpolated literals still group together: the
  observable signature of an N+1
- ✅ **Execution graph** — a request's events as a real dependency DAG,
  nested by what ran *inside* what, rendered flame-chart style in the Request
  Inspector with each row's bar proportional to when it ran and for how long
- ✅ **Session recording** — optionally record the live protocol stream to
  a portable JSON Lines file on disk, without changing anything about the
  live dashboard while it's on
- ✅ **Session loading** — open a recording later, offline, with no live
  runtime required; the same dashboard, streaming events from the file
  instead of a WebSocket
- ✅ **Replay & time travel** — play, pause, restart, step, seek, and
  change playback speed (0.25x–8x) through an opened recording, with the
  dashboard's request list, waterfall, performance insights, execution
  graph, and exception details all reconstructed live at whatever
  position you're viewing — deterministically, and fast enough to seek
  around a recording with tens of thousands of events
- ✅ **Outgoing HTTP** (`@wevna/plugin-fetch`) — every `fetch()` your app
  makes, correlated to the request that triggered it, with credentials
  stripped from recorded URLs
- ✅ **Plugin SDK** — teach Wevna about anything it doesn't instrument
  itself, with a versioned plugin api, a lifecycle tied to the runtime's,
  declarative capability discovery via `wevna.plugins`, and fault isolation
  so a failing plugin can never take down the application it's observing
- ✅ **Search, filtering, pause/resume/clear** — on the live event stream,
  entirely client-side

Framework-specific route/handler enrichment is available for
[Fastify](examples/fastify/README.md) and [NestJS](examples/nest/README.md)
as an explicit opt-in; Express gets it automatically.

## Architecture

```
   YOUR APPLICATION                          A RECORDING FILE
          │                                   (session.jsonl)
          │  console.log · http · pg · redis         │
          ▼  exceptions · plugins                   ▼
   ┌─────────────────┐                      ┌─────────────────┐
   │  Instrumentation│                      │  Session Loader │
   └────────┬────────┘                      └────────┬────────┘
            │  CapturedEvent                         │
            ▼                                        ▼
   ┌─────────────────┐                      ┌─────────────────┐
   │     Runtime     │  stamps id, session, │  Replay Engine  │ "where am I?"
   │                 │  sequence, and the   └────────┬────────┘
   │  Envelope<T>    │  active correlation           │
   └────────┬────────┘                               ▼
            │                               ┌─────────────────┐
            ▼                               │ Snapshot Engine │ "what should
   ┌─────────────────┐                      └────────┬────────┘  show here?"
   │    EventBus     │                               │
   └────┬───────┬────┘                               │
        │       │                                    │
        ▼       ▼                                    │
   WebSocket  Session                                │
        │     Recorder ──────────────────────────────┘
        │        │
        │        └──► session.jsonl
        ▼                                    ▼
   ┌────────────────────────────────────────────────┐
   │                   DASHBOARD                    │
   │  one event-source hook — live or replayed      │
   │                                                │
   │  Request Inspector · Waterfall · Insights      │
   │  Execution Graph · Exceptions · Search         │
   └────────────────────────────────────────────────┘
                          ▲
                          │  pure, React-free models
                 ┌────────┴─────────┐
                 │  @wevna/protocol │  what an event *is*
                 │   intelligence   │  what a request *means*
                 └──────────────────┘
```

**Your application never talks to the dashboard.** Instrumentation observes
in-process and emits a `CapturedEvent`. The Runtime is the single place that
turns one into an `Envelope` — stamping the protocol version, session id,
sequence number, and whichever correlation is active for the calling async flow.
That last part is how every producer gets request correlation *for free*: none
of them know correlation exists.

From the EventBus, events fan out to two independent subscribers: the WebSocket
the local server hosts, and — only if you asked for it — the Session Recorder.
Neither knows about the other, which is why recording changes nothing about
live behaviour.

**A recording is just another event source.** `openRecording()` feeds a file
through the same server and dashboard. For replay specifically, two small
React-free modules sit in between, and neither knows the other exists: the
**Replay Engine** owns *when* (position, playback state, speed) as a
timer-driven state machine, and the **Snapshot Engine** owns *what should be
shown at that position*, using periodic `sqrt(n)` checkpoints so seeking a
large recording stays fast instead of rebuilding from scratch on every scrub.

The dashboard consumes both through the **same single hook** it uses for live
mode — which is why every feature works identically in both, with no
`if (replaying)` anywhere in the UI.

**One rule decides where code lives:** the dashboard owns presentation and UI
state; `intelligence` owns everything true about a request regardless of who's
looking. So assembling events into a request, deriving its timeline, computing
attribution, and reconstructing state at a replay position all live in
`intelligence` — while the stores deciding *when* to rebuild and who to notify
stay in the dashboard. That's what lets a future CLI, or a test asserting over a
recording, find out what a request was without importing React.

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
- ✔ Execution graph model
- ✔ Execution graph renderer (dependency DAG, nested + proportional)
- ✔ Time attribution & repeated-operation detection
- ✔ Session recording
- ✔ Session loading (offline inspection)
- ✔ Plugin SDK (versioned api, lifecycle, capability discovery, fault isolation)
- ✔ Official plugin: outgoing HTTP via `fetch`
- ✔ Replay engine & time travel (play/pause/restart/step/seek/speed, with
  deterministic dashboard state reconstruction at any position)

**Next**

- More official plugins (MongoDB, Prisma, BullMQ)
- Cross-request views (slow endpoint ranking, global statistics)
- Dashboard polish (dark theme, keyboard shortcuts, command palette,
  virtualized event list)

## Packages

This is a pnpm monorepo. The published `wevna` package (`packages/sdk`) is
the only one you install; everything else supports it:

| Package               | What it is                                      |
| ---------------------- | ------------------------------------------------ |
| `packages/sdk`         | The `wevna` package — public API, Runtime, instrumentation |
| `packages/protocol`    | The shared event/envelope types every other package agrees on. Published as `@wevna/protocol` for plugin authors and anything reading a recording file |
| `packages/server`      | The local Fastify server + WebSocket transport the SDK starts |
| `packages/dashboard`   | The React dashboard UI, served by the local server |
| `packages/intelligence`| Deterministic runtime interpretation — request assembly, timelines, replay snapshots, performance analysis, execution graph modeling. No React, no Fastify, reusable outside the dashboard |
| `packages/plugin-fetch`| Official plugin: outgoing HTTP (`fetch`) capture. Lives outside the SDK on purpose — it is written against nothing but the published plugin api |

## Contributing / running locally

```bash
git clone https://github.com/wevna/wevna.git
cd wevna
pnpm install
pnpm build
pnpm test
```

Requires Node 22+ and pnpm. See [examples/](examples/) for integration
patterns with specific frameworks, and [TESTING.md](TESTING.md) for how to
verify a change — both the automated gate and a manual end-to-end checklist.

Releases are cut by pushing a version tag (`v1.0.0`); CI runs the full
build/check/test/lint gate and publishes the three public packages with npm
provenance. Publishing from a laptop cannot produce a provenance attestation,
which is why it goes through CI — drop `publishConfig.provenance` if you'd
rather run `pnpm release` locally.

## Stability

`PROTOCOL_VERSION` and `PLUGIN_API_VERSION` are frozen at `1` for the 1.x
line. Three published packages — `wevna`, `@wevna/protocol`,
`@wevna/plugin-fetch` — everything else is internal and bundled.

Wevna guarantees it never changes what your code does and never throws into
your code path. It does *not* claim plugins are sandboxed, that URL redaction
is exhaustive, or that graph nesting implies causality. All of that is spelled
out in [STABILITY.md](STABILITY.md), along with what a major bump means for
each contract.

Changes are recorded in [CHANGELOG.md](CHANGELOG.md).
[PROJECT_STATUS.md](PROJECT_STATUS.md) is a full architectural handoff — what
was built, what was decided and why, and what's deliberately left.

## License

[MIT](LICENSE)
