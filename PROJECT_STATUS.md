# Wevna: Project Status

Where Wevna is, how it got here, what was decided and why, and what is left.
Written 2026-10-23 against `main` at the merge of #100. Where a section describes
work that is not on `main` yet, it says so and names the pull request. This file is
meant to merge after the pull requests it lists, so the README table it adds
describes `main` at that point.

---

## 1. What Wevna is

A local-first runtime understanding tool for backend developers. One call starts a
local dashboard at `localhost:4123` that shows what a backend is doing at runtime,
correlated per request: HTTP, SQL, Redis, outgoing calls, logs and exceptions.

It exists for two languages now. The Node SDK is the stable one. The Python SDK
serves the same dashboard from the Python process and writes the same event
protocol, and is alpha.

The target is Chrome DevTools for backend runtimes. It is not a logging library, an
APM, a cloud service or another OpenTelemetry SDK. Nothing leaves the machine.

The repository is a pnpm and Turborepo monorepo: TypeScript, Fastify, React, Vitest,
tsup and Biome for the JavaScript side, and Python with pytest, mypy (strict) and
ruff, driven through turbo by a small shim.

---

## 2. Current state

| | Version | Published |
| --- | --- | --- |
| `@wevna/sdk` | 1.1.2 | yes. The next release is prepared in #90 (1.2.0) |
| `@wevna/protocol` | 1.0.0 | yes |
| `@wevna/plugin-fetch` | 1.0.0 | yes |
| `@wevna/plugin-mongodb`, `-prisma`, `-mysql` | 0.1.0 | no. No npm trusted publisher yet |
| `wevna` (Python) | 0.1.0 | no. Alpha, no PyPI release workflow on `main` yet (#91) |

`main` is green. The full gate (`pnpm turbo run build check test lint`) runs 45
tasks, and CI runs it on every pull request.

Tests on `main`: about 1,450. By package: dashboard 507, sdk 279, python 283,
intelligence 180, server 77, plugin-fetch 74, protocol 26, plugin-mongodb 11,
plugin-mysql 9, plugin-prisma 6.

Releases so far: 1.0.0 (the first), 1.1.0 (the dashboard redesign), 1.1.1 (a
README refresh for the npm page) and 1.1.2 (SQL and example fixes). There have been
76 commits since 1.0.0.

---

## 3. Where the phases landed

| Phase | Theme | State |
| --- | --- | --- |
| 1 | Foundation (monorepo, tooling, CI) | done |
| 2 | Boot runtime (SDK, Runtime, Server, Dashboard) | done |
| 3 | Runtime protocol and live inspection | done |
| 4 | Runtime intelligence (correlation to replay) | done |
| 5 | Replay and time travel | done |
| 6 | Extensibility: Plugin SDK and official plugins | done. Six plugins: fetch, mongodb, prisma, mysql, and the built-in pg and redis |
| 7 | Better understanding (graph, attribution, N+1) | done, per request and across requests (endpoint ranking) |
| 8 | Better replay (bookmarks, comparison, diff, compression) | deliberately not built |
| 9 | Dashboard UX | partly done: light and dark themes, keyboard shortcuts, command palette. Resizable panels and a virtualized list are not built |
| 10 | V1 hardening | done |
| Python 1 | Package, runtime core, ASGI middleware, dashboard | done on `main` |
| Python 2 | SQLAlchemy, redis-py, httpx, log capture | done on `main` |
| Python 3 | Recording and replay | in review (#92) |

---

## 4. Architecture

```
YOUR APP (Node or Python)                  RECORDING FILE (.jsonl)
   | http, sql, redis, logs, exceptions            |
   | plugins                                       |
   v                                               v
Instrumentation                              Session Loader
   | CapturedEvent                                 |
   v                                               v
Runtime: stamps protocol version, session,   Replay Engine ("where am I?")
   |     sequence, active correlation              |
   | Envelope<CapturedEvent>                       v
   v                                         Snapshot Engine ("what shows here?")
EventBus                                           |
   |--> WebSocket -----------------------------------+
   `--> Session Recorder --> .jsonl                  |
                                                     v
                            DASHBOARD (one event-source hook, live or replayed)
                                     ^
                            @wevna/protocol (JSON Schema + fixtures)
                            + intelligence (pure, React-free models)
```

The dashboard is one React bundle. The Node server serves it from the Node process
and the Python server serves the same bundle from the Python process. A Python
session and a Node session are the same thing to the UI.

### The rule that decides where code lives

The dashboard owns presentation and UI state. `packages/intelligence` owns
everything true about a request regardless of who is looking at it: request
assembly, timelines, the execution graph, time attribution, repetition detection and
replay snapshot reconstruction.

### The protocol is a contract, not a TypeScript API

The event and recording formats are defined by a JSON Schema
(`packages/protocol/schema`) and by conformance fixtures, and both SDKs' test suites
read the same files. Three fixtures keep the two languages from drifting:

- the schema and event fixtures (`packages/protocol/fixtures`),
- the URL-redaction cases (`packages/plugin-fetch/fixtures/sanitize-url.json`, TypeScript
  authoritative, the Python sanitizer asserts against it),
- the Host and Origin guard cases (`packages/server/fixtures/host-guard.json`, the
  same arrangement).

### Packages

| Package | Published | Role |
| --- | --- | --- |
| `packages/sdk` (`@wevna/sdk`) | yes | Public API, Runtime, instrumentation |
| `packages/protocol` (`@wevna/protocol`) | yes | Event, envelope and recording types, schema and fixtures |
| `packages/plugin-fetch` | yes | Outgoing HTTP, the reference plugin |
| `packages/plugin-mongodb`, `plugin-prisma`, `plugin-mysql` | no | Datastore plugins, 0.1.0 |
| `packages/server`, `dashboard`, `intelligence` | no, bundled | Local Fastify server, React UI, pure models |
| `python/wevna` | no | The Python SDK |

---

## 5. What shipped since 1.0.0

### In releases (1.1.0 to 1.1.2)

- A redesigned dashboard: a session timeline on one shared axis, a design-token layer,
  light and dark themes, a tabbed request inspector and kind filters.
- A rewritten README built around what the dashboard looks like.
- Postgres quoted identifiers are no longer collapsed in repeated-query detection
  (`"Users"` and `"Orders"` were reported as one query).
- A runnable Express example with no database or containers.
- Publishing through npm trusted publishing (OIDC), so releases carry provenance.

### On `main`, unreleased

- **A security fix.** Any web page open in a developer's browser could read the live
  event stream. Fixed for Node (#80) and for the Python server (#81). Details in
  section 7.
- **Cross-request endpoint ranking** in the dashboard.
- **Keyboard shortcuts, a help overlay and a command palette** (Cmd or Ctrl K).
- **A `database` event category** for datastores that are neither SQL nor Redis,
  carried through the metrics, insights, N+1 detection and the dashboard.
- **Three datastore plugins:** `@wevna/plugin-mongodb` (the driver's command
  monitoring, nothing patched), `@wevna/plugin-prisma` (a client extension) and
  `@wevna/plugin-mysql` (mysql2's promise API, emitting `sql.query` so all SQL
  analysis applies unchanged). They are tested against structural fakes, as the `pg`
  support is. `mysql2` and the `mongodb` driver were also checked for wrapping and
  event field names, but no database server was available.
- **A dashboard error boundary**, so one badly shaped plugin event cannot blank the UI.
- **Audit cleanups from #48 and layout fixes from #54** (#82), including a
  `/api/session/events` that streams a recording instead of buffering it.
- **A Python SDK on `main`** (PRs #61 to #73, and fixes since): ASGI middleware, per-request
  correlation through `contextvars`, `logging` capture, the dashboard served from the
  process, SQLAlchemy (sync and async), redis-py (sync and async) and httpx. Fixes
  since: thread-safe sequence numbers and `correlation.bind` (#85), `port=0` (#86) and
  the forked-worker leak (#87).

### In review (a snapshot; the pull requests are the source of truth)

| PR | What |
| --- | --- |
| #90 | Release prep for `@wevna/sdk` 1.2.0, the SECURITY.md entry, STABILITY.md |
| #91 | Python release workflow for PyPI, a dry-run package check, packaging fixes |
| #92 | Python Phase 3: recording and replay, with conformance fixtures both ways |
| #93 | Python WSGI middleware with Flask and Django integrations |
| #94 | A design note on the Python SDK under pre-fork servers |
| #95 | Python: redis-py pipelines |
| #96 | Python: the `requests` library |
| #97 | Python: raw asyncpg |
| #98 | A demo kit: a Node and a Python service calling each other |
| #101 | Removes `.pyc` files and an egg-info directory committed by mistake |
| #102 | A CI check that fails if a draft post, a work report or build output is tracked |
| #88 | An earlier maintainer TODO, superseded by the `TODO.md` in this change |

The order to merge them in, and why, is in [TODO.md](TODO.md).

---

## 6. Decisions worth challenging

These are judgement calls. Each is documented in code or in `STABILITY.md`.

**Fault isolation, not sandboxing.** Privilege isolation for plugins is incoherent
here: instrumentation works by wrapping the developer's own objects, in process. A
plugin that cannot touch your objects cannot observe them. What is guaranteed is that
a failing `setup()` is quarantined, a throwing teardown does not stop the others, and
a failed `publish()` never surfaces at the plugin's call site.

**Built-ins go through the public plugin API.** If the shipped instrumentation cannot
be written against the documented surface, no community plugin will manage it.

**Graph nesting is containment, not causality.** Wevna observes when operations
started and finished, never who called whom.

**Time attribution is not a critical path.** Concurrent operations each count in
full, so shares can sum past 100%. That is reported, not normalised away.

**`PLUGIN_API_VERSION` is matched exactly, not with `>=`.**

**The Python SDK serves its own dashboard.** It does not need Node. An earlier
prototype sent Python events to a Node process over an ingest endpoint. It
was closed when the self-hosted SDK landed on `main`, because it needed a second
runtime and a second write path into the dashboard. What it found was kept as fixes.

**The same safety rules in both languages.** SQL parameters, Redis arguments, request
and response bodies and headers are never recorded. Failures are reported by a short
code where the driver has one (a SQLSTATE, a MySQL or Prisma error code, an exception
class for `requests`), because a message often quotes the value that caused it.
Redis and httpx errors have no code, so their message is recorded. See section 9 for
the one case where that matters.

**A recording requires `sequence` to increase along the file.** The dashboard orders
events by timestamp and uses `sequence` only as a tiebreak, but the loader reports a
`sequence-gap` otherwise. Anything that merges several processes into one recording
must assign its own sequence.

**Pipelined Redis commands (#95) get an equal share of the batch time.** Per-command
timing does not exist in a pipeline. The real total is recorded on every event.

---

## 7. Bugs found along the way

Most came from tests written to assert a property, or from running the real thing,
not from the feature under construction.

| Bug | Why it mattered |
| --- | --- |
| **Any web page could read the event stream** (fixed in #80, #81) | Browsers do not apply the same-origin policy to WebSockets, so any site could connect to `ws://localhost:4123/ws` and receive every SQL query, request and log line from a running Wevna. DNS rebinding reached the HTTP routes the same way. Affects every `@wevna/sdk` before the fix. The server now refuses a foreign `Host` and a foreign `Origin` on the WebSocket. Both servers read one shared fixture. |
| Concurrent `publish()` could repeat a sequence number (Python, #85) | Sync endpoints run in a threadpool. A thread switch between reading and incrementing the counter gave two events the same number, about 4% of events under stress. |
| Forked workers leaked memory and lost events (Python, #87) | A pre-fork server forks after `start()`. The dashboard thread does not survive, so events queued on a loop nobody ran: 180 MB per 200,000 events. |
| `start(port=0)` reported port 0 (Python, #86) | The real port was never read back. |
| A second worker's `start()` stalls for 6 seconds and claims to be running | Not fixed. Measured for the design note (#94). |
| `NaN` in an event attribute lost the event (Python, #92) | Python writes bare `NaN`, which is not JSON. `JSON.parse` rejects the whole message. |
| `instrumentRedis(new Redis(url))` did not type-check (Node, #98) | The documented usage failed in TypeScript. Every test used a hand-written stand-in. |
| The SQL insight said "PostgreSQL" for MySQL and Python (#89) | `sql.query` now comes from several drivers. |
| `requests` exception messages contain the URL and query string (Python, #96) | Recording `str(error)` would put back a secret that the `url` field had redacted. |
| asyncpg logs its own housekeeping (Python, #97) | The pool's reset after every query and type introspection would have appeared as phantom events. |
| The WSGI body is pulled after the app returns (Python, #93) | A first prototype only reported a request when the body was exhausted and held context state across yields. |
| A pipeline error recorded the Redis command's arguments (Python, #95) | redis-py rewrites the error a pipeline raises to `Command # 2 (LPUSH key value) of pipeline caused error: ...`. Found by running against a real Redis 7. |
| Flask in debug mode reported each exception twice (Python, #93) | Flask reports the exception to its signal and then re-raises it to the WSGI middleware. |
| The WSGI middleware dropped `Content-Length` (Python, #93) | Wrapping the body hid `len()`, which wsgiref and gunicorn use to set the header for a one-item list. |
| A stuck recording writer got a footer in the middle of its lines (Python, #92) | `stop()` gave up waiting for the writer and wrote the footer anyway, then closed the file under it. |
| The test suite failed to import on Python 3.11 and newer (#91) | SQLAlchemy 2.1 stopped installing greenlet, and the dev extra used bare `sqlalchemy`. CI runs 3.10, which resolves 2.0, so CI stayed green. |

A row that names a pull request numbered above #89 is fixed in a change that is
still open, not on `main`.

Earlier, in the 1.0 work: a build race between `tsup` and `tsc`, unbounded dashboard
memory, quadratic event ingestion, an `http` category that double-counted, a
`register(undefined)` that threw, and published types that imported unpublished
packages.

---

## 8. What was deliberately not built

- **Advanced replay** (bookmarks, request comparison, session diff, compression).
- **Dashboard polish beyond shortcuts:** resizable panels, a virtualized list (less
  urgent since retention is capped at 10,000 events).
- **Capturing every worker under a pre-fork server.** Only the process that called
  `start()` hosts the dashboard. #94 compares per-worker dashboards with a relay to
  one collector and asks for a decision.
- **Scrubbing URLs inside log messages.** Log capture records what an application's
  loggers write, and some libraries log full URLs. Redaction applies to the events
  Wevna records itself. This is documented and has real false-positive risk.
- **Other Python databases** (psycopg, MongoDB) and Python web frameworks that
  speak neither ASGI nor WSGI.

## 9. Known gaps

- **The Node SDK records an incoming request's URL with its query string.** The
  Python SDK records the path only. Query strings can carry tokens (OAuth callbacks,
  signed URLs), and they reach the live stream and recordings. Needs a decision: the
  same redaction rules as outgoing URLs, or the path only.
- **A failed MongoDB write is reported as a success.** Checked against MongoDB 7: a
  duplicate-key insert returns `ok: 1` with `writeErrors` in the reply, and the plugin
  reads only `commandFailed`. Not fixed. A fix should record the write error's code,
  not its message, which quotes the duplicate value.
- **`@wevna/plugin-mysql` does not cover connections from `pool.getConnection()`.**
  `instrument(pool)` covers `pool.query()` and `pool.execute()`. A connection taken
  from the pool must be passed to `instrument()` itself. The README does not say so.
- **A Redis "unknown command" error quotes the start of its arguments.** The server
  writes `ERR unknown command 'x', with args beginning with: ...`, and Redis errors
  are recorded by message. Both SDKs.
- **The Python SDK is alpha.** Its API can change in any release and is not covered
  by `STABILITY.md`, although its protocol is.
- **`start()` in a second Python worker stalls and misreports** (see section 7).
  Reproduced under `gunicorn -w 2` without `--preload`: the second worker fails to
  bind, waits 5 seconds, and prints "Wevna running".

---

## 10. Verification status

```
pnpm turbo run build check test lint --force
 Tasks:    45 successful, 45 total
```

- About 1,450 tests, and zero lint warnings.
- Cross-language contracts are asserted from both sides: the schema and event
  fixtures, URL redaction and the Host and Origin guard.
- Run against the real thing on 2026-10-23, in addition to the test suites:
  - `@wevna/plugin-mongodb` against MongoDB 7 and `@wevna/plugin-mysql` against
    MySQL 8.4, through a Node HTTP server: events correlated per request, no values
    in the stream, MySQL errors recorded by code.
  - redis-py pipelines (#95) against Redis 7, sync, async and transactional.
  - asyncpg (#97) against PostgreSQL 16 (its tests skip when run as root).
  - The FastAPI example under `gunicorn -w 2 -k uvicorn.workers.UvicornWorker`, with
    and without `--preload`, 9,000 requests each. With `--preload` each worker logs
    the forked-worker warning once. Worker memory stayed flat after warm-up.
  - The Flask example (#93) and a small Django app behind gunicorn, driven by the
    demo traffic script: every event correlated to its request, routes recorded,
    exceptions attached once, the example's `api_key` redacted.
  - The demo kit (#98) with `docker compose`: both services, both dashboards, and
    the cross-service calls correlated on each side.
  - A recording written by the FastAPI example (#92), replayed through
    `wevna.open_recording` in headless Chromium (controls, inspector, endpoint
    table, no page errors) and loaded by the Node SDK's `openRecording`.
  - `npm pack --dry-run` for the six public packages and a wheel and sdist build:
    the dashboard bundle is present, no tests in the npm tarballs or the wheel, no
    compiled Python or egg-info.
- A real browser was used earlier to check the dashboard's shortcuts, command
  palette and layout fixes.

Manual end-to-end checks are in `TESTING.md`.

---

## 11. To actually publish

Nothing here has been done, and all of it needs credentials. The ordered steps are
in [TODO.md](TODO.md). In short: merge the security fixes, configure npm trusted
publishers for the three new plugins, release `@wevna/sdk` 1.2.0, publish the GitHub
security advisory, and set up PyPI before the first Python release.

---

## 12. What is next

If asked "what now", the honest ranking:

1. **Release the security fix.** It affects every published version.
2. **Record the demo.** `examples/demo` (#98) makes it mechanical. A real recording
   is still the biggest adoption lever and needs a person.
3. **Decide the pre-fork story** for the Python SDK (#94), and fix the second-worker
   stall whichever way it goes.
4. **Decide how incoming query strings are handled** in the Node SDK.
5. **Fix the two plugin gaps found against real servers** (section 9): MongoDB
   write errors, and MySQL pool connections.
6. **Python to beta:** publish to PyPI, then decide what belongs under `STABILITY.md`.

Reference: [README.md](README.md) for usage, [STABILITY.md](STABILITY.md) for what
is guaranteed, [SECURITY.md](SECURITY.md), [TESTING.md](TESTING.md),
[CHANGELOG.md](CHANGELOG.md), [TODO.md](TODO.md).
