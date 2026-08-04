# Testing Wevna

How to verify Wevna works — from the fast automated gate to actually watching a
real request flow through the dashboard.

Read this top to bottom the first time. After that you'll mostly live in
[The fast loop](#the-fast-loop).

---

## The one command

```bash
pnpm turbo run build check test lint
```

That's the whole gate, and it's exactly what CI runs. All four must pass. If
this is green, the codebase is in a good state.

```
 Tasks:    28 successful, 28 total
```

**Always run it from a cleared cache before you trust a result on a branch
you're about to merge:**

```bash
rm -rf .turbo packages/*/dist packages/*/.turbo
pnpm turbo run build check test lint
```

Why: turbo caches aggressively and correctly, but a cache hit tells you "these
inputs produced this result before" — not "this works right now from nothing".
A partial build artifact has been cached as a success in this repo before (see
[CHANGELOG.md](CHANGELOG.md) 1.0.0, the `build`/`check` race), and a clean run
is the only thing that would have caught it.

### What each task actually checks

| Task | Command | Catches |
| --- | --- | --- |
| `build` | `tsup` + `tsc --build` | Bundling failures, and emits the `.d.ts` files consumers get |
| `check` | `tsc --build` | Type errors, **including in test files** |
| `test` | `vitest run` | Behaviour |
| `lint` | `biome check` | Style, import order, and accessibility rules |

`check` depends on `build` deliberately — they both invoke `tsc --build` on the
same project, and running them concurrently used to race over one
`tsbuildinfo`.

Don't skip `lint`. Biome's `a11y` rules are load-bearing here: they're what
caught a `role="tree"` that promised keyboard navigation the dashboard didn't
implement.

---

## The fast loop

While actively working, run one package's tests in watch mode:

```bash
cd packages/dashboard && pnpm exec vitest        # watch
cd packages/dashboard && pnpm exec vitest run    # once
```

Filter to a file or a test name:

```bash
pnpm exec vitest run src/execution-graph-layout.test.ts
pnpm exec vitest run -t "nests an operation inside another"
```

**One gotcha:** running `vitest` directly needs the workspace packages already
built, because a package imports `@wevna/intelligence` from its `dist/`. If you
just cleared `dist/`, you'll get `Failed to resolve import "@wevna/intelligence"`.
Fix by going through turbo once — it builds dependencies first:

```bash
pnpm turbo run test --filter=@wevna/dashboard
```

Add `--force` to bypass the cache when you want to be sure it really ran.

---

## Where the tests live, and what they're for

Every module has a `.test.ts` beside it. Roughly 470 tests across four
packages. What matters is that they're split by *what they can prove*:

| Package | Files | What it proves |
| --- | --- | --- |
| `packages/sdk` | 18 | The runtime, instrumentation, correlation, plugins, recording — behaviour against real HTTP servers and fake clients |
| `packages/dashboard` | 31 | Stores, layout math, and every React component through the DOM |
| `packages/intelligence` | 11 | Pure functions: request assembly, timelines, graph, attribution, repetition |
| `packages/server` | 3 | The local Fastify server and its routes |

### The layering matters when a test fails

If a dashboard test and an intelligence test fail together, **fix the
intelligence one first** — the dashboard consumes it, so the second failure is
probably a symptom.

- **`intelligence` tests use fixed numbers.** No clocks, no randomness. They
  pin exact nesting, exact percentages, exact orderings. If one of these fails,
  a real behavioural contract changed.
- **`dashboard` component tests query the DOM by role and text**, not by
  internal class names where it can be helped, so they survive restyling.
- **`App.test.tsx` is the integration test.** It renders the whole dashboard
  against a mocked WebSocket / fetch. It's the slowest and the most valuable —
  it's what catches "the panel renders but nothing wired it in".

### A real lesson encoded in the tests

`App.test.tsx` builds fixtures from **real elapsed time**. That made one
execution-graph assertion depend on whether a `console.log` happened to land
inside the HTTP request's measured window — it genuinely flipped between runs.

The fix wasn't to pin the timing; it was to make the App-level test assert what
it actually cares about (the graph is wired in and renders every event once) and
leave exact nesting to `ExecutionGraphSection.test.tsx`, which uses fixed
offsets.

**The general rule: assert at the layer that can be deterministic about the
thing you're asserting.** If you find yourself sorting a result to make a test
pass at the integration level, that's usually the signal.

---

## Testing it by hand, end to end

Automated tests don't tell you whether the dashboard *feels* right. Do this
before any release.

### 1. Build once

```bash
pnpm install
pnpm build
```

The dashboard's built assets are copied into the SDK's `dist/` by
`scripts/copy-dashboard-assets.mjs`, so `pnpm build` is required — a dev-mode
dashboard won't be what a user gets.

### 2. Run an example

```bash
cd examples/express && pnpm dev
```

There are runnable examples for [express](examples/express/),
[fastify](examples/fastify/), and [nest](examples/nest/). Each README says what
endpoints it exposes.

### 3. Open the dashboard

`http://localhost:4123`

### 4. Walk this checklist

Hit an endpoint, then verify:

- [ ] The request appears in the request list with the right method, route,
      status and a plausible duration
- [ ] Selecting it fills the inspector: summary, waterfall, insights, graph
- [ ] The waterfall's `http.request` bar spans the whole track, and child
      operations sit *inside* it — not after it. (A bar ends at its completion
      time and extends backward; getting this wrong is the classic bug here.)
- [ ] A `console.log` renders as a marker, not a zero-width bar
- [ ] "Where the time went" shows categories that add up plausibly
- [ ] The execution graph nests SQL/Redis under `http.request`
- [ ] Search filters the event list live
- [ ] **Pause**, then send more requests: the count keeps rising but the list
      freezes. Resume: the held events appear
- [ ] **Clear** empties the list without breaking the live stream

### 5. Exercise the insights deliberately

The interesting paths need traffic that triggers them:

```ts
// N+1 → "Repeated Query"
const ids = await pool.query("SELECT id FROM orders LIMIT 5");
for (const row of ids.rows) {
  await pool.query(`SELECT * FROM order_items WHERE order_id = ${row.id}`);
}

// "Slow Request" + "Where The Time Went"
await pool.query("SELECT pg_sleep(1.2)");

// "Exception Occurred"
throw new Error("deliberate");
```

The N+1 case is worth doing with **interpolated** ids specifically — that's
what proves shape normalization is grouping them rather than treating each as a
distinct query.

### 6. Recording and replay

```ts
await wevna.startRecording("./session.jsonl");
// ... generate some traffic ...
await wevna.stopRecording();
```

Sanity-check the file before opening it:

```bash
head -1 session.jsonl | jq          # header: formatVersion, protocolVersion, session
tail -1 session.jsonl | jq          # footer: recordingEndedAt, eventCount
wc -l session.jsonl
```

Then in a **separate** process, with your app not running:

```ts
import { openRecording } from "wevna";
const result = await openRecording("./session.jsonl");
console.log(result.ok ? result.recording.url : result.error);
```

- [ ] Opens **fully played** — you see everything immediately
- [ ] **Restart** jumps to the start and plays through with recorded timing
- [ ] **Step Forward/Back** moves one event at a time
- [ ] Dragging the **seek slider** is instant even near the end
- [ ] Speed selector genuinely changes playback rate
- [ ] Letting it play to the end shows **"End of recording"** — and pausing
      manually on the last event does *not*. (Those are different states; see
      `replay-engine.ts`.)
- [ ] Selecting a request mid-replay shows the inspector reconstructed at
      *that position*, not the final state

### 7. Verify the safety guarantees

These are the promises in [STABILITY.md](STABILITY.md), and they're worth
checking by hand because a regression here is worse than a missing feature:

- [ ] **Comment out `wevna.start()`** but keep `instrumentPg()` and a plugin
      registered. Your app must work normally — no throws, no events.
- [ ] **Call `wevna.stop()`** while traffic is flowing. Queries keep working.
- [ ] **Register a deliberately broken plugin** (`setup()` throws). Your app
      still starts, and `console.table(wevna.plugins)` shows it as `failed`
      with the reason.
- [ ] **Register a plugin with `apiVersion: 999`.** Reported, not thrown.

### 8. Check retention under load

Leave the dashboard open and generate sustained traffic for a few minutes.

- [ ] The tab stays responsive
- [ ] Memory plateaus rather than climbing without bound (the caps are 10,000
      events / 1,000 requests)
- [ ] Ingestion doesn't slow down as the session gets longer — this used to be
      quadratic, and the symptom was the dashboard getting sluggish exactly
      when traffic picked up

---

## Verifying what gets published

Before cutting a release, check the actual artifacts rather than trusting the
config:

```bash
cd packages/sdk && npm pack --dry-run
```

- [ ] `dist/dashboard/assets/…` present — otherwise the published package
      serves a blank dashboard
- [ ] **No `*.test.d.ts` files** (18 were shipping once)
- [ ] `dist/index.d.ts` imports nothing from `@wevna/server`,
      `@wevna/dashboard`, or `@wevna/intelligence` — those are internal and
      unpublished, so a consumer would get unresolvable types:

```bash
grep -rl "@wevna/server\|@wevna/dashboard\|@wevna/intelligence" packages/sdk/dist/*.d.ts
# must print nothing
```

Repeat `npm pack --dry-run` for `packages/protocol` and
`packages/plugin-fetch`.

---

## Writing new tests

Match what's there. A few conventions that are load-bearing rather than
cosmetic:

**Say why, not just what.** A test name states the behaviour; a comment states
why the behaviour is correct. `"treats identical spans as siblings, never
nesting one inside the other"` plus a comment explaining that mutual
containment would otherwise let sort order decide — that's what stops someone
"simplifying" it back into a bug.

**Test the boundary, not just the happy path.** The threshold tests check 2
*and* 3, not just 3. The cap tests check 0 and 500, not just the cap.

**Assert on absence too.** `expect(attributes).not.toHaveProperty("statusCode")`
for a failed request. `expect(serialized).not.toContain("super-secret")` for
redaction. Several real defects here were "it also included something it
shouldn't".

**Restore your spies.** Use `afterEach(() => vi.restoreAllMocks())`. A
`vi.spyOn` left in place accumulates calls across tests and silently makes every
call-count assertion meaningless — this bit me during development.

**Watch out for default parameters and `undefined`.** JS treats an explicitly
passed `undefined` as an omitted argument, so a helper with
`durationMs = 100` will use `100` when you pass `undefined` deliberately. Build
the object inline for that case.

**Add a complexity guard where complexity is the point.** The 20,000-event
append test and the 400-deep nesting test aren't benchmarks — they're guards
against someone reintroducing an O(n²) path. Keep the bounds generous so
they don't fail on a slow CI runner.
