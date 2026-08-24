# Stability

What Wevna promises not to break, and what it explicitly doesn't promise.

Wevna follows semver. The rules below define what a **major** version bump
means for each contract, so you can tell in advance whether an upgrade can
affect you.

## Published packages

Only these are published. Everything else in the repository is internal and
may be restructured, renamed, or deleted in any release.

| Package | What it is |
| --- | --- |
| `@wevna/sdk` | The SDK. What you install and call. |
| `@wevna/protocol` | Event, envelope and recording-file types. Needed to write a plugin or read a recording. |
| `@wevna/plugin-fetch` | Official plugin: outgoing HTTP capture. |

`@wevna/server`, `@wevna/dashboard` and `@wevna/intelligence` are **internal**.
They are bundled into `@wevna/sdk` rather than published. Do not depend on them —
importing them is not a supported use, and their APIs change without notice.

### The Python SDK is not covered yet

`python/wevna` is at `0.1.0` and **nothing below applies to it**. Its Python
API may change in any release, and it is not published to PyPI.

One thing about it *is* already fixed: the **protocol**. A Python-produced
event stream is held to the same
[schema and conformance fixtures](packages/protocol/fixtures/) as a
Node-produced one, and both SDKs' test suites read the same files. So
`PROTOCOL_VERSION` and `RECORDING_FORMAT_VERSION` mean exactly what they mean
below regardless of which language wrote a recording — while the Python
*package* API is still free to move.

## Three independently versioned contracts

Wevna versions three things separately, because they change for different
reasons and conflating them would force major bumps that break nobody.

### 1. The package version (semver, currently `1.0.0`)

Covers everything exported from `@wevna/sdk`'s entrypoint: the `wevna` object's
methods, the framework helpers, `openRecording`, `SessionLoader`, and the
plugin authoring types.

A **major** bump means one of those was removed or changed incompatibly.

Not covered — these can change in a minor release:

- The dashboard's UI, DOM, and CSS. It is an application, not an API.
- Log output and warning wording.
- Which insights fire, and their `message` text. Insight *types* are stable;
  the thresholds behind them and the prose are tuning.
- Anything reachable only by reaching past the entrypoint into `dist/`.

### 2. `PROTOCOL_VERSION` (currently `1`)

The shape of `CapturedEvent`, `Envelope`, `Session`, and the event kinds and
attributes producers emit. Stamped onto every envelope, so a consumer always
knows what it is reading.

**Frozen at 1 for the 1.x line.** Within it:

- New **optional** fields may be added. A consumer that ignores them is
  unaffected, and recordings stay readable by older readers.
- New **event kinds** may be added. `kind` is an open string by design —
  handling an unrecognized kind gracefully is a consumer's job, and every
  built-in consumer already does.
- New **attributes** may be added to an existing kind.
- Existing fields will not be removed, renamed, or have their meaning or type
  changed. That requires `PROTOCOL_VERSION: 2`.

`RECORDING_FORMAT_VERSION` (currently `1`) is versioned separately again, for
the same reason: a change to how a recording file is framed on disk does not
imply the events inside it changed shape, or vice versa.

### 3. `PLUGIN_API_VERSION` (currently `1`)

`PluginContext`, `WevnaPlugin`, `PluginEvent`, and the plugin lifecycle.

A plugin declares the api version it was built against and Wevna checks it
**exactly**, not with `>=`. A plugin built for a newer api would expect
context methods that don't exist; one built for an older api may rely on
behaviour that changed. Either way "unsupported" is the honest answer, and it
is reported through `wevna.plugins` rather than thrown — see below.

Within version 1:

- Methods may be **added** to `PluginContext`. A plugin that doesn't call them
  is unaffected.
- Optional fields may be added to `WevnaPlugin` and `PluginEvent`.
- Nothing existing is removed or changed. That requires
  `PLUGIN_API_VERSION: 2`.

## What Wevna promises about your application

These are behavioural guarantees, not API surface, and they are the ones that
actually matter in production:

- **Wevna never changes what your code does.** Instrumentation observes and
  passes through. A wrapped `query()` returns exactly what the original
  returned; a wrapped `fetch()` returns the same response and rethrows the
  same error object by identity.
- **Wevna never throws into your code path.** Publishing an event, registering
  a plugin, or a plugin failing its own setup cannot surface as an exception at
  your call site. `wevna.use()` does not throw on any input; an unusable plugin
  is reported through `wevna.plugins`.
- **Calls before `start()` and after `stop()` are safe.** They publish nothing
  and do not fail.
- **Nothing leaves your machine.** No network egress, no telemetry, no account.
  The dashboard binds to localhost by default.

The one documented exception, because it is a real behaviour change and hiding
it would be worse: `ExceptionInstrumentation` registers process-level
`uncaughtException` / `unhandledRejection` listeners, which affects Node's
default crash behaviour. See `exception-instrumentation.ts`.

## Memory and retention

The live dashboard keeps a **bounded** amount of history: the most recent
10,000 events and 1,000 requests, oldest evicted first. A local-first tool has
no server-side retention to fall back on, so the bound lives in the dashboard.

Both numbers are internal and may change in a minor release. If you need
history beyond them, record the session — that is what recordings are for, and
a recording is not subject to either cap.

## What is deliberately not guaranteed

- **Plugins are not sandboxed.** They run in your process with full access to
  it, because instrumentation works by wrapping your real client objects. What
  is guaranteed is *fault* isolation — a plugin's failures stay its own.
  Plugins are code you install and trust, like any other dependency.
- **URL and query redaction is a conservative default, not a guarantee.**
  `@wevna/plugin-fetch` strips userinfo and redacts conventionally-named
  sensitive query parameters. A secret in a path segment, or under an
  unconventional name, will still be recorded.
- **Time attribution is not a critical path.** Concurrent operations each count
  in full, so category shares can sum past 100%. Reporting that is deliberate;
  inventing a serialization the runtime never had would be worse.
- **Execution graph nesting is containment, not causality.** An operation that
  ran inside another's time window is reported as nested. That is not a claim
  that one caused the other — nothing Wevna observes could establish that.

## Reporting a break

If an upgrade breaks something covered above, that's a bug, not a migration —
please open an issue at
[github.com/wevna/wevna/issues](https://github.com/wevna/wevna/issues).
