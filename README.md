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

### Recording a session

Optionally, record the live event stream to a portable file on disk:

```ts
await wevna.startRecording("./session.jsonl");

// ... your app runs, events stream live to the dashboard as always ...

await wevna.stopRecording();
```

This is not replay — the dashboard doesn't change while a recording is
active, and nothing controls playback timing. It's one JSON object per
line (a header, then one line per event, then a footer), so a recording
is safe to inspect with `cat`/`tail -f`/`jq` even while it's still being
written. Entirely opt-in: if you never call `startRecording()`, nothing
changes.

### Opening a recording offline

Once you have a recording, open it later — no running application, no
live runtime required:

```ts
import { openRecording } from "wevna";

const result = await openRecording("./session.jsonl");
if (result.ok) {
  console.log(`Dashboard running at ${result.recording.url}`);
} else {
  console.error(result.error);
}
```

This starts the same local dashboard the live path uses, reading events
from the file instead of a WebSocket. The dashboard opens fully played by
default — exactly what you'd see if you'd loaded it before replay
existed — with a transport controls bar (Restart, Step Back/Forward,
Play/Pause, a seek slider, and a playback speed selector) letting you
scrub through the recording and watch it unfold at up to 8x recorded
speed or one event at a time. Every existing dashboard feature (request
inspection, waterfall, exceptions, performance insights, execution graph,
search, filtering) works exactly as it does live at whatever position
you're viewing, because from the dashboard's point of view it *is* live —
just backed by a file instead of a running process, with a
position you control instead of "now."

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
- ✅ **Execution graph** — a request's events as a structured, ordered graph
  (currently shown as a simple sequential flow in the Request Inspector),
  reusable outside the dashboard for whatever renders it next
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
- ✅ **Search, filtering, pause/resume/clear** — on the live event stream,
  entirely client-side

Framework-specific route/handler enrichment is available for
[Fastify](examples/fastify/README.md) and [NestJS](examples/nest/README.md)
as an explicit opt-in; Express gets it automatically.

## Architecture

```
Application                  Recording File
     │                             │
     ▼                             ▼
    SDK                     Session Loader
     │                             │
     ▼                             ▼
  Runtime                   Replay Engine
     │                             │
     │                             ▼
     │                     Snapshot Engine
     │                             │
     ▼                             ▼
 WebSocket  ─────────────►    Dashboard
```

Your application code never talks to the dashboard directly. The SDK
instruments your app in-process, the Runtime turns what it observes into a
structured protocol event and publishes it, and the dashboard receives it
live over a WebSocket the Runtime's local server hosts alongside your app.
Nothing leaves your machine.

A recording is just another event source: `openRecording()` reads a file
back through the same local server and dashboard, so the dashboard itself
never needs to know whether events came from a live runtime or a file on
disk. For a recording specifically, two small, independent,
React-free modules sit between the file and the dashboard: the Replay
Engine tracks *when* — position, playback state, speed, preserving
recorded relative timing — purely as a timer-driven state machine over the
loaded event list, and the Snapshot Engine turns a replay position into
*what the dashboard should show* (the request list at that point in time),
using periodic checkpoints so seeking around a large recording stays fast
without rebuilding everything from scratch on every scrub. Neither engine
knows the other exists, and the dashboard consumes both through the same
single event-source hook it already used for live vs. offline mode.

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
- ✔ Session recording
- ✔ Session loading (offline inspection)
- ✔ Replay engine & time travel (play/pause/restart/step/seek/speed, with
  deterministic dashboard state reconstruction at any position)

**Next**

- Graph visualization (the model exists; a real renderer doesn't yet)
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
| `packages/intelligence`| Deterministic request performance analysis and execution graph modeling — no React, no Fastify, reusable outside the dashboard |
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
