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

### Writing a plugin

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
*what should be shown* (the request list at that point in time),
using periodic checkpoints so seeking around a large recording stays fast
without rebuilding everything from scratch on every scrub. Neither engine
knows the other exists, and the dashboard consumes both through the same
single event-source hook it already used for live vs. offline mode.

Where a piece of logic lives follows one rule: the dashboard owns
presentation and UI state, and `packages/intelligence` owns everything
that is true about a request regardless of who is looking at it. So
assembling raw events into a request, deriving its timeline, and
reconstructing state at a replay position all live in `intelligence`,
while the stores that decide *when* to rebuild a model and who to notify
stay in the dashboard. That split is what keeps a future CLI, or a test
that asserts over a recording, from having to import React to find out
what a request was.

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
patterns with specific frameworks.

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

## License

[MIT](LICENSE)
