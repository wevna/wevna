# Wevna — Project Status

A complete handoff document. Everything a reviewer needs to know about where
Wevna is, how it got here, what was decided and why, and what's left.

Current state: **v1.0.0, release-ready, not yet published.** `main` is green.

---

## 1. What Wevna is

A local-first runtime understanding platform for backend developers. One call —
`await wevna.start()` — and a local dashboard at `localhost:4123` shows what a
Node.js backend is doing at runtime, correlated per request.

The target is **Chrome DevTools for backend runtimes**. Not a logging library,
not an APM, not a cloud SaaS, not another OpenTelemetry SDK.

Repository: a pnpm + Turborepo monorepo. TypeScript, Fastify, React, Vitest,
tsup, Biome.

---

## 2. Where the phases landed

| Phase | Theme | State |
| --- | --- | --- |
| 1 | Foundation (monorepo, tooling, CI) | ✅ |
| 2 | Boot runtime (SDK, Runtime, Server, Dashboard) | ✅ |
| 3 | Runtime protocol & live inspection | ✅ |
| 4 | Runtime intelligence (correlation → replay) | ✅ |
| 5 | Replay & time travel | ✅ |
| 6 | Extensibility (Plugin SDK + official plugins) | ✅ core, 3 of 5 plugins |
| 7 | Better understanding (graph, attribution, N+1) | ✅ per-request; cross-request not started |
| 10 | V1 hardening | ✅ |

Phases 8 (better replay) and 9 (dashboard UX) were **deliberately not built**.
See [§8](#8-what-was-deliberately-not-built).

---

## 3. Architecture as it now stands

```
YOUR APP                                   RECORDING FILE (.jsonl)
   │ console.log · http · pg · redis                │
   │ exceptions · plugins                           │
   ▼                                                ▼
Instrumentation                             Session Loader
   │ CapturedEvent                                  │
   ▼                                                ▼
Runtime ── stamps protocol version, session,   Replay Engine ("where am I?")
   │        sequence, active correlation            │
   │ Envelope<CapturedEvent>                        ▼
   ▼                                          Snapshot Engine ("what shows here?")
EventBus                                            │
   ├──► WebSocket ──────────────────────────────────┤
   └──► Session Recorder ──► .jsonl                  │
                                                    ▼
                              DASHBOARD (one event-source hook, live or replayed)
                                       ▲
                              @wevna/protocol + intelligence
                              (pure, React-free models)
```

### The rule that decides where code lives

The dashboard owns **presentation and UI state**. `packages/intelligence` owns
**everything true about a request regardless of who is looking at it**.

So request assembly, timelines, the execution graph, time attribution,
repetition detection, and replay snapshot reconstruction all live in
`intelligence`. The stores that decide *when* to rebuild a model and who to
notify stay in the dashboard.

This was tightened during this phase in response to review feedback — see
[§5](#5-review-feedback-and-how-it-was-addressed).

### Packages

| Package | Published? | Role |
| --- | --- | --- |
| `packages/sdk` → `wevna` | **yes, 1.0.0** | Public API, Runtime, instrumentation |
| `packages/protocol` → `@wevna/protocol` | **yes, 1.0.0** | Event/envelope/recording types |
| `packages/plugin-fetch` → `@wevna/plugin-fetch` | **yes, 1.0.0** | Official plugin: outgoing HTTP |
| `packages/server` | no — bundled | Local Fastify server + WebSocket |
| `packages/dashboard` | no — bundled | React UI |
| `packages/intelligence` | no — bundled | Pure interpretation layer |

`packages/shared` was **deleted** — it exported a single `noop()`, was
referenced by nothing, and was documented in the README as though real.

---

## 4. What was built in this phase (PRs #30–#39)

All merged to `main`. Every one verified with
`pnpm turbo run build check test lint` clean from a **cleared** cache.

### #30 — Domain logic into `intelligence`; `finished` playback state
Moved `SnapshotEngine`, `buildRequestModel`, `buildTimeline`/`TimelineEntry`,
and `compareEvents` out of the dashboard. `RequestStore` now *uses*
`buildRequestModel` instead of owning it. Added `finished` as a third
`PlaybackState`, distinct from `paused`.

### #33 — Plugin SDK
`wevna.use()`, `PluginContext`, `WevnaPlugin`, `PLUGIN_API_VERSION`,
`wevna.plugins` for capability discovery, and fault isolation. Added optional
`source` to `CapturedEvent` for event provenance.

### #34 — Built-in producers expressed as plugins
`pg` and `redis` instrumentation now reach the runtime through the **public**
plugin api, registered as `wevna:pg` / `wevna:redis`. `instrumentPg()` /
`instrumentRedis()` unchanged for callers.

### #35 — `@wevna/plugin-fetch`
Outgoing HTTP capture as `http.client` events, in its own package — the first
producer written against nothing but the published plugin api. Includes URL
sanitization. Split `httpClient` from `http` in event categorization.

### #36 — Execution graph: real dependency DAG + renderer
Nesting derived from interval containment. Added `parentId`, `depth`,
`startedAtMs` to nodes; `rootIds`, `maxDepth` to the graph; `"parent-child"`
alongside `"sequential"` edges. New flame-chart-style renderer with
proportional bars.

### #37 — Time attribution + repeated-operation detection
`attributeRequestTime()` answers "where did this request's time go".
`detectRepeatedOperations()` finds the same query shape run N times — the N+1
signature — with SQL normalized to a shape.

### #38 — Publishable + v1 contracts frozen
**The actual production blocker.** Every package was `private: true`, so
`npm install wevna` was impossible. Three packages now publish at 1.0.0. Closed
internal-package leaks from published type declarations. Narrowed
`wevna.start()`'s options. Added `STABILITY.md`, `CHANGELOG.md`, and a release
workflow.

### #39 — Bounded memory + quadratic ingestion fix
Both stores grew without limit; `EventStore#append` copied the entire history
per event (O(n²) per session). Now capped at 10,000 events / 1,000 requests with
amortized O(1) appends.

---

## 5. Review feedback, and how it was addressed

The PR #29 review raised three things. All are now resolved:

**1. "`SnapshotEngine` should live in `packages/intelligence`."** Done in #30.
`DashboardSnapshot` was renamed `RuntimeSnapshot` — nothing in that package
should assume a UI is what consumes it.

**2. "`RequestStore` shouldn't own domain construction."** Done in #30, and
taken further than asked: `compareEvents` moved too, because `RequestStore` and
`SnapshotEngine` both have to agree on what "chronological" means, and two
copies of that comparison are two chances for replay to quietly stop matching
live mode.

**3. "Distinguish end-of-replay from paused."** Done in #30, as a third
`PlaybackState` rather than an `onReplayFinished()` callback. Rationale: the
engine already has exactly one way to tell consumers anything (`subscribe` +
`getSnapshot`), and a parallel notification channel would be one more thing to
wire up, forget to unsubscribe from, and keep consistent with a snapshot it
could contradict. `pause()` now refuses to overwrite `finished`.

---

## 6. Decisions worth challenging

These are judgement calls where a reviewer might reasonably disagree. Each is
documented in code and in `STABILITY.md`.

### Fault isolation, not sandboxing
The roadmap listed "safe plugin isolation". **Privilege isolation is incoherent
for this problem:** instrumentation works by wrapping the developer's *actual*
`pg.Pool` — real references, in-process. A worker thread or `vm` context puts a
boundary between a plugin and the objects it exists to observe. A plugin that
can't touch your objects can't observe them.

What is guaranteed instead: a failing `setup()` is quarantined and the runtime
still starts; a throwing teardown doesn't stop others unwinding; a failed
`publish()` never surfaces at the plugin's call site; `register()` never throws
on any input. The README says plainly that plugins are code you install and
trust, like any other dependency.

### Built-ins go through the public plugin api
Not on the original roadmap; added deliberately. A plugin system whose own
built-ins bypass it rots — if the shipped instrumentation can't be written
against the documented surface, no community plugin will manage it, and there's
no way to *notice* the surface is insufficient until an outside contributor
gives up.

### Graph nesting is containment, not causality
Wevna observes when operations started and finished, never who called whom. An
operation that ran inside another's window is reported as nested. That is not a
claim that one caused the other, and the code says so.

### Time attribution is not a critical path
Concurrent operations each count in full, so category shares can sum past 100%.
That's reported rather than normalized away — inventing a serialization the
runtime never had would be worse.

### `PLUGIN_API_VERSION` is matched exactly, not `>=`
A plugin built against a newer api expects context methods that don't exist;
one built against an older api may rely on changed behaviour. "Unsupported" is
the honest answer.

### Sequencing: graph renderer before MongoDB/Prisma
The Features list already claimed an execution graph while the UI rendered a
flat list. Closing a gap in something already advertised beat adding a fourth
and fifth data source — especially since Mongo/Prisma can't be meaningfully
tested without pulling in those drivers.

### An a11y decision reversed mid-PR
The graph renderer started with `role="tree"` + `aria-level`. Backed out: the
ARIA tree pattern is an interactive widget with obligations the view doesn't
meet (focusable items, roving tabindex, arrow keys), and claiming the role
without the behaviour promises keyboard users something that isn't there. It's a
plain list, and nesting reaches a screen reader by **naming the parent**
("inside sql.query") rather than as a level number.

---

## 7. Bugs found along the way

Notable because **most came from tests written to assert a property**, not from
the feature under construction.

| Bug | Why it mattered |
| --- | --- |
| **turbo/tsc build race** | `build` and `check` shared one `tsbuildinfo` while `tsup` wiped `dist/`. The loser left partial `.d.ts` files, and `check` declaring no outputs meant turbo cached that *as a success*. Timing-dependent — would have hit CI at random. |
| **Unbounded dashboard memory** | Both stores grew for as long as the dashboard stayed open. |
| **Quadratic event ingestion** | Every append copied the whole history. The dashboard got slower exactly as traffic increased. |
| **`http` category double-counting** | `categoryBreakdown` sums every entry, and `http.request` contains the whole request. Adding `http.client` would have let a request report an http total *larger than its own duration*. |
| **`register(undefined)` threw** | The rejection path read `plugin.name` before validating it — caught by the test asserting `register` never throws. |
| **React duplicate-key warning** | Insights keyed on `type`, unique only while one insight per type could fire. Multiple N+1 findings broke it. |
| **Published types imported internal packages** | Consumers would have got unresolvable types for packages never going to npm. |
| **18 `*.test.d.ts` files shipping** | Test declarations in the published tarball. |
| **`wevna.start()` leaked internals** | Accepted the server's options wholesale, including `eventSource`/`session` — passing them would silently detach the dashboard from the runtime's event bus. |
| **Latently flaky App test** | Its graph assertion depended on wall-clock timing deciding where a `console.log` nested. Order genuinely flipped between runs. |

Two places the existing architecture absorbed new work with **zero changes**,
which is evidence the earlier design bets paid off: `http.client` became
eligible as a request's slowest operation automatically (the metric excluded
`http.request` *specifically* as the container, not "http" as a category), and
the dashboard's prefix-based categorization classified it correctly — exactly
what that file's comment predicted.

---

## 8. What was deliberately not built

Not oversights — judgement calls, listed so they can be argued with:

- **MongoDB / Prisma plugins.** The v1 bar was "3–5 official plugins"; there are
  3 (pg, redis, fetch). These two are the most speculative code in the project
  without the real drivers to test against.
- **Cross-request views** (slow endpoint ranking, global statistics). Genuinely
  useful, genuinely additive, and needs no architecture change — a good first
  post-1.0 item.
- **Dashboard UX** (dark theme, keyboard shortcuts, command palette, resizable
  panels, virtualized list). The CSS already uses `color-scheme: light dark` so
  it adapts; the rest is polish. Note that a virtualized list is *less* urgent
  now that retention is capped at 10,000 events.
- **Advanced replay** (bookmarks, request comparison, session diff, compression).
- **A demo GIF.** Still the biggest gap for adoption. The README now has an
  ASCII illustration of the dashboard instead, but a real recording would do
  far more. This needs a human with a screen recorder.

---

## 9. Verification status

```
pnpm turbo run build check test lint
 Tasks:    28 successful, 28 total
```

- ~470 tests: 31 dashboard test files, 18 sdk, 11 intelligence, 3 server
- Zero lint warnings
- CI green on `main`
- Verified from a **cleared** turbo cache, not a cache hit
- `npm pack --dry-run` verified on all three public packages: dashboard assets
  present, zero test declarations, types resolving standalone

`TESTING.md` documents both the automated gate and a manual end-to-end
checklist.

---

## 10. To actually publish

Not done — it needs credentials and is irreversible.

1. Add an `NPM_TOKEN` secret to the GitHub repository
2. `git tag v1.0.0 && git push origin v1.0.0`

CI runs the full build/check/test/lint gate, then publishes the three public
packages with npm provenance. Publishing from a laptop cannot produce a
provenance attestation, which is the only reason that workflow exists — drop
`publishConfig.provenance` and run `pnpm release` if local publishing is
preferred.

---

## 11. Suggested next milestone

If asked "what now", the honest ranking:

1. **A demo GIF or short screencast.** Biggest adoption lever, needs a human.
2. **Cross-request views** — slow endpoint ranking and global statistics. Pure
   addition over models that already exist, and the first thing that makes
   Wevna useful *across* requests rather than one at a time.
3. **Dashboard UX** — keyboard shortcuts and a command palette, which is where
   the DevTools comparison currently feels least earned.
4. **MongoDB / Prisma plugins** — best done by someone who uses them daily.

Documentation reference: [README.md](README.md) for usage,
[STABILITY.md](STABILITY.md) for what's guaranteed,
[TESTING.md](TESTING.md) for verification, [CHANGELOG.md](CHANGELOG.md) for what
changed in 1.0.0.
