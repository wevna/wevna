# Changelog

All notable changes to Wevna are documented here. This project follows
[semver](https://semver.org/); see [STABILITY.md](STABILITY.md) for exactly
what each version number covers.

## 1.1.0 — `@wevna/sdk`

A redesigned dashboard. `@wevna/protocol` and `@wevna/plugin-fetch` are
unchanged and stay at `1.0.0` — the UI is compiled into the SDK at build
time, so it is the only package whose contents moved.

### Added

- **Session timeline** — every request in the session on one shared time
  axis, so you can see how requests overlap rather than only what happened
  inside one of them.
- **Design system** — a token layer (`design-system.css`) behind the whole
  UI, and Archivo as the interface typeface.
- **Theme toggle** — light and dark, with the choice remembered.
- **Tabbed request inspector** — Overview, Attributes and Performance,
  instead of one long scrolling column.
- **Kind filters** on both timelines — All, SQL, Redis, Errors.

### Changed

- Failed requests are now visually distinct in the request list and on both
  timelines, rather than differing only by status code text.

### Note on provenance

This is the first release published through npm's trusted publishing
(OIDC), so it carries a provenance attestation. `1.0.0` does not: it was
published before the trusted publisher existed, and pnpm fell back to a
token without failing the build. See the comment in `release.yml`.

## 1.0.0

First stable release. `PROTOCOL_VERSION` and `PLUGIN_API_VERSION` are frozen
at `1` for the 1.x line.

> **The SDK publishes as `@wevna/sdk`, not `wevna`.** npm's automated
> similar-name check rejects `wevna` as too close to the existing `levn` and
> `lerna`, so the flagship package is scoped like the other two. Only the
> package name changed — the import binding is still `wevna`:
>
> ```ts
> import { wevna } from "@wevna/sdk";
> ```

### Added

- **Plugin SDK** — `wevna.use()`, a versioned plugin api, lifecycle tied to the
  runtime's, declarative capability discovery via `wevna.plugins`, and fault
  isolation so a failing plugin cannot take down the application observing it.
- **`@wevna/plugin-fetch`** — outgoing HTTP capture, correlated to the request
  that triggered it, with credentials stripped from recorded URLs.
- **Execution graph** — a real dependency DAG derived from interval
  containment, rendered flame-chart style with proportional bars.
- **Time attribution** — per-category answer to "where did this request's time
  go", instead of a duration alone.
- **Repeated-operation detection** — the same query shape run N times in one
  request, normalized so interpolated literals still group: the observable
  signature of an N+1.
- **`@wevna/protocol` is now published**, so plugin authors and anything
  reading a recording file can depend on the event shapes directly.
- `WevnaStartOptions`, `STABILITY.md`, and this changelog.
- A release workflow that publishes on a pushed `v*.*.*` tag, running the full
  build/check/test/lint gate first and attaching npm provenance.

### Changed

- **`wevna.start()` accepts a narrower options type.** It previously accepted
  `@wevna/server`'s `StartServerOptions`, which also carried `eventSource` and
  `session` — internal wiring that, if passed, would silently detach the
  dashboard from the runtime's event bus. It now takes `WevnaStartOptions`:
  `port`, `host`, `dashboardDir`. Anyone passing only those is unaffected.
- Built-in PostgreSQL and Redis instrumentation are now implemented as
  plugins, so they appear in `wevna.plugins` and their events carry
  `source: "wevna:pg"` / `"wevna:redis"`. `instrumentPg()` and
  `instrumentRedis()` are unchanged for callers.
- Request construction, timelines and replay snapshots moved into the
  internal intelligence layer, so the dashboard no longer owns what a request
  *is*. No public API change.
- Replay distinguishes `finished` (playback ran to the end) from `paused`
  (something stopped it). `PlaybackState` gained a third value.

### Fixed

- A CI-affecting build race: `build` and `check` shared one `tsbuildinfo`
  while `tsup` wiped `dist/` between them, and the loser left a partial set of
  declaration files that turbo then cached as a success.
- `CapturedEvent` gained an optional `source`, recording which plugin produced
  an event. Built-in always-on producers omit it, so existing recordings stay
  byte-identical.
- Published type declarations no longer reference internal packages, so
  `wevna`'s types resolve standalone.
- A React duplicate-key warning in the performance panel once more than one
  insight of a type could fire.
- Test declaration files are no longer included in published tarballs.
- **Unbounded dashboard memory growth.** Both the event and request stores grew
  for as long as the dashboard stayed open. They now retain the most recent
  10,000 events and 1,000 requests, oldest evicted first. Requests are capped
  too because a request holds references to its own events, so capping the
  event list alone would not have released them.
- **Quadratic event ingestion.** Every append copied the entire event history,
  making a session O(n²) — the dashboard got slower exactly when traffic picked
  up. Appends are now amortized O(1), with the immutable snapshot React needs
  rebuilt once per read after a change instead of once per event.

### Removed

- `@wevna/shared` — an unreferenced placeholder exporting a `noop()`.

### Publishing

Wevna was previously unpublishable: every package was marked `private: true`,
so the documented `npm install` could not work. The three public
packages are now published, at `1.0.0`, from CI on a version tag.
