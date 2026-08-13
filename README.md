<div align="center">

# Wevna

**See what your backend is actually doing.**

[![npm](https://img.shields.io/npm/v/@wevna/sdk?color=2ea043&label=%40wevna%2Fsdk)](https://www.npmjs.com/package/@wevna/sdk)
[![CI](https://github.com/wevna/wevna/actions/workflows/ci.yml/badge.svg)](https://github.com/wevna/wevna/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-5FA04E)](https://nodejs.org)

One line of code. A live dashboard at `localhost:4123` showing every HTTP
request, SQL query, Redis command and `console.log` your Node.js backend
makes — grouped under the request that caused it.

No agent. No account. No network egress. Nothing leaves your machine.

<img src="https://raw.githubusercontent.com/wevna/wevna/main/docs/images/dashboard-demo.gif" alt="The Wevna dashboard filling up live as requests hit an Express app" width="100%">

</div>

---

## The problem

You're debugging a slow endpoint. So you do this:

```js
console.log("got here");
console.log("query done", Date.now() - t0);
console.log("still here??");
```

It works. But you're rebuilding, by hand, a picture your runtime already
has: which query ran for which request, how long it took, what happened
before and after it.

Wevna just shows you that picture.

```
GET /orders/42                                      200 · 294ms

  console.log     ●                                   +0ms
  sql.query       ▏                                   +3ms ·   3ms
  redis.command   ▏                                   +5ms ·   2ms
  sql.query          ███                             +49ms ·  38ms
  sql.query             ███                          +89ms ·  39ms
  sql.query                ███                      +127ms ·  38ms
  sql.query                   ███                   +165ms ·  38ms
  http.client                     ████████          +290ms · 124ms
  http.request    ████████████████████████          +293ms · 294ms

  Repeated Query   The same query ran 4 times, taking 155ms in total:
                   select * from order_items where order_id = ?
```

Four identical queries in a row. That's an N+1, and you didn't have to go
looking for it.

---

## Install

```bash
npm install @wevna/sdk
```

<sub>`pnpm add @wevna/sdk` · `yarn add @wevna/sdk` · requires **Node 22+**</sub>

> **Heads up on the name:** the package is `@wevna/sdk`, not `wevna`. npm's
> automated similar-name check rejects the unscoped name as too close to the
> existing `levn` and `lerna`. The import binding is still `wevna`.

## Quick start

Put this as early in your startup as you can:

```ts
import { wevna } from "@wevna/sdk";

await wevna.start();
```

That's it. Open **`http://localhost:4123`** and hit an endpoint.

You now get every `console.log`, every HTTP request your app serves (method,
route, status, duration), and every uncaught exception — all **correlated**,
so events from one request are grouped under that request automatically.

```ts
await wevna.start({
  port: 4123,        // default; use 0 to let the OS pick a free port
  host: "localhost", // default; not reachable off-machine
});
```

---

## What you see

<img src="https://raw.githubusercontent.com/wevna/wevna/main/docs/images/request-inspector.png" alt="The Wevna dashboard: session timeline, request list, per-event timeline and the request inspector" width="100%">

**Session timeline** (top) — every request on one shared time axis, so you
can see how they overlap, not just what happened inside one.

**Request list** — think Chrome's Network panel. Failed requests stand out.

**Request inspector** — pick a request and get its summary, a waterfall of
everything that happened inside it, where the time went, insights, and an
execution graph.

### Light or dark

<img src="https://raw.githubusercontent.com/wevna/wevna/main/docs/images/dashboard-dark.png" alt="The Wevna dashboard in dark theme" width="100%">

---

## Adding your database and cache

There's no global "every `pg.Pool`" hook to patch, so these are opt-in. Hand
Wevna the client you already created, once:

```ts
import { Pool } from "pg";
import Redis from "ioredis";
import { wevna } from "@wevna/sdk";

await wevna.start();

const pool = new Pool();
wevna.instrumentPg(pool);      // → sql.query events

const redis = new Redis();
wevna.instrumentRedis(redis);  // → redis.command events
```

Everything you already do with `pool` / `redis` keeps working **identically**.
Wevna wraps the method, times the call, and passes the result straight
through. Order doesn't matter — before or after `start()`.

### What gets recorded, and what doesn't

| | Recorded | **Not** recorded |
| --- | --- | --- |
| PostgreSQL | Query text, duration, row count | Parameter **values** (`args[1]` is never read) |
| Redis | Command name, duration | Command arguments or results |
| `console.log` | The formatted message, as a string | The raw argument objects |
| Outgoing HTTP | Method, sanitized URL, status, duration | Headers and bodies |

Redis arguments are never captured because commands routinely carry the value
inline (`SET session:abc <token>`) — unlike parameterized SQL, there's no safe
subset to keep.

`console.log` is captured the way it prints: arguments go through
`util.format` and only the resulting string is kept. Log something live and
deeply connected — `console.log(req)` — and you get the same line you saw in
your terminal, with nothing hanging off it.

---

## Outgoing HTTP

A request that spends 400ms waiting on a third-party API looks identical to a
slow handler until you can see the call.

```bash
npm install @wevna/plugin-fetch
```

```ts
import { wevna } from "@wevna/sdk";
import { createFetchPlugin } from "@wevna/plugin-fetch";

wevna.use(createFetchPlugin());
await wevna.start();
```

Every `fetch()` now appears in the waterfall of the request that triggered it.

```ts
// Keep a chatty internal dependency out of the stream:
wevna.use(createFetchPlugin({ ignoreHosts: ["metrics.internal"] }));
```

URLs are sanitized before recording: userinfo stripped, sensitive-looking
query parameter *values* redacted. Headers and bodies are **never** recorded.
See [the plugin's README](packages/plugin-fetch/README.md) for the exact rules
— and note they're a conservative default, not a guarantee.

---

## Framework setup

| Framework | What you need to do |
| --- | --- |
| **Express** | Nothing. Route and handler enrichment is automatic. |
| **Fastify** | Register one plugin for route names. |
| **NestJS** | Register one interceptor for route/handler names. |

HTTP capture itself is framework-agnostic and needs no wiring — these only add
richer route/handler attributes.

<details>
<summary><b>Express</b> — optional error handler</summary>

Nothing is required, but add the error handler *last* to capture handler
exceptions (Express has no hook Wevna can patch for this):

```ts
import express from "express";
import { wevna, wevnaExpressErrorHandler } from "@wevna/sdk";

await wevna.start();
const app = express();

// ... your routes ...

app.use(wevnaExpressErrorHandler);  // last, after all routes
```

It only observes and always calls `next(err)`, so it never changes what
response Express ends up sending.

</details>

<details>
<summary><b>Fastify</b></summary>

```ts
import Fastify from "fastify";
import { wevna, wevnaFastifyEnrichment } from "@wevna/sdk";

await wevna.start();
const app = Fastify();
await app.register(wevnaFastifyEnrichment);
```

</details>

<details>
<summary><b>NestJS</b></summary>

```ts
import { WevnaNestInterceptor } from "@wevna/sdk";

app.useGlobalInterceptors(new WevnaNestInterceptor());
```

</details>

---

## Insights

Wevna flags things worth a second look, always with the numbers behind them:

| Insight | Fires when |
| --- | --- |
| **Repeated Query / Redis Command** | The same operation ran ≥ 3 times |
| Slow Request | Total duration > 1000ms |
| Long SQL Execution | Any single query > 100ms |
| Multiple Database Calls | More than 5 queries |
| Multiple Redis Operations | More than 5 commands |
| Where The Time Went | One category took > 60% of the request |
| Exception Occurred | Any exception was captured |

Repeated-operation detection normalizes query *shape*, so a loop
interpolating `id = 1`, `id = 2`, `id = 3` is recognised as one repeated query
— the observable signature of an N+1.

It **reports rather than diagnoses**: a repeated query is often an N+1 and
sometimes entirely correct. Same with the execution graph — nesting is derived
from timing containment, so it means *"this ran during that"*, **not** *"this
caused that"*. Nothing Wevna observes could establish causality.

Shares can sum past 100% for genuinely concurrent work. That's reported rather
than normalised away, because inventing a serialisation the runtime never had
would be worse.

---

## Recording and replay

Record the live stream to a portable file:

```ts
await wevna.startRecording("./session.jsonl");
// ... your app runs; the dashboard behaves exactly as before ...
await wevna.stopRecording();
```

It's JSON Lines — a header, one line per event, then a footer — so it's safe
to `tail -f` or pipe through `jq` while it's still being written, and a
recording cut short by a crash is still valid up to its last complete line.

Open it later, with no running application:

```ts
import { openRecording } from "@wevna/sdk";

const result = await openRecording("./session.jsonl");
if (result.ok) {
  console.log(`Dashboard running at ${result.recording.url}`);
  // ... await result.recording.close() when done
} else {
  console.error(result.error);  // structured, never thrown
}
```

You get the same dashboard plus a transport bar: **Restart**, **Step
Back/Forward**, **Play/Pause**, a **seek slider**, and **0.25×–8×** speed.
Every feature — inspector, waterfall, insights, graph, search — works at
whatever position you're scrubbed to, because from the dashboard's point of
view it *is* live, just backed by a file whose position you control.

A freshly opened recording starts **fully played**, so opening one shows you
everything immediately rather than an empty screen.

---

## API

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

---

## Should I run this in production?

Wevna never changes what your code does, never throws into your code path, and
sends nothing off your machine. But it's built for **development and
staging**, and two things matter before you reach for it in production:

- **The dashboard is unauthenticated.** Anything that can reach port 4123 can
  read the captured stream. It binds to `localhost` by default for exactly
  this reason.
- **Everything is in memory**, bounded by a retention cap. It's sized for a
  debugging session, not for continuous operation.

Treat it as a `devDependency` in spirit.

---

## Writing a plugin

The plugin API is frozen at `PLUGIN_API_VERSION = 1` for the whole 1.x line.

```ts
import { PLUGIN_API_VERSION, wevna, type WevnaPlugin } from "@wevna/sdk";

const myPlugin: WevnaPlugin = {
  name: "my-plugin",
  apiVersion: PLUGIN_API_VERSION,
  setup(ctx) {
    const timer = setInterval(() => {
      ctx.publish({
        kind: "my.event",
        attributes: { note: "something happened" },
      });
    }, 1000);

    return () => clearInterval(timer);  // teardown
  },
};

wevna.use(myPlugin);
```

`ctx.publish` never throws. A plugin whose `setup()` fails is quarantined and
disabled rather than taking down the app observing it — check
`wevna.plugins` to see status. `@wevna/plugin-fetch` is the reference
implementation.

> Fault isolation is about **accidents, not malice**. Plugins are not
> sandboxed and run with full process privileges — installing one is
> equivalent to installing any other dependency.

---

## Troubleshooting

<details>
<summary>The dashboard is blank</summary>

Check `http://localhost:4123/health` — it should return
`{"status":"running","product":"wevna"}`. If that works but the UI is empty,
the dashboard bundle may be missing from the install; reinstall
`@wevna/sdk`.

</details>

<details>
<summary>I see requests but no SQL or Redis events</summary>

Those are opt-in. You need `wevna.instrumentPg(pool)` /
`wevna.instrumentRedis(client)` with the actual client instance your code
uses. Only the Promise-returning `query()` form is observed — callback-style
calls pass through unobserved rather than being guessed at.

</details>

<details>
<summary>Port 4123 is already in use</summary>

`await wevna.start({ port: 0 })` lets the OS pick a free port.

</details>

<details>
<summary>Events stop appearing after a while</summary>

Retention is bounded on purpose. The oldest events are dropped once the cap is
reached — record to a file if you need the whole history.

</details>

---

## Packages

| Package | | What it is |
| --- | --- | --- |
| [`@wevna/sdk`](https://www.npmjs.com/package/@wevna/sdk) | published | The SDK — what you install and call. Dashboard bundled in. |
| [`@wevna/protocol`](https://www.npmjs.com/package/@wevna/protocol) | published | The event and recording-file contract |
| [`@wevna/plugin-fetch`](https://www.npmjs.com/package/@wevna/plugin-fetch) | published | Outgoing HTTP capture, and the reference plugin |
| `@wevna/server` · `@wevna/dashboard` · `@wevna/intelligence` | internal | Bundled into the SDK — don't depend on these |

---

## Stability

`PROTOCOL_VERSION` and `PLUGIN_API_VERSION` are frozen at `1` for the 1.x
line.

Wevna guarantees it **never changes what your code does** and **never throws
into your code path**. It does *not* claim plugins are sandboxed, that URL
redaction is exhaustive, or that graph nesting implies causality.

All of it — including what a major bump would mean for each contract — is
spelled out in **[STABILITY.md](STABILITY.md)**. Changes are recorded in
[CHANGELOG.md](CHANGELOG.md).

## Contributing

```bash
git clone https://github.com/wevna/wevna.git
cd wevna
pnpm install
pnpm build
pnpm test
```

One command runs exactly what CI runs:

```bash
pnpm turbo run build check test lint
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the full guide — repository layout, and
what we look for in a change. [TESTING.md](TESTING.md) covers how to verify
one. [PROJECT_STATUS.md](PROJECT_STATUS.md) is the architectural handoff: what
was built, what was decided, and what's deliberately left.

Participation is covered by our [Code of Conduct](CODE_OF_CONDUCT.md).
Security issues go through [SECURITY.md](SECURITY.md), privately, rather than
the public issue tracker.

## License

[MIT](LICENSE)
