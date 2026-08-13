# Contributing to Wevna

Thanks for wanting to help. This document covers the parts that aren't
obvious from reading the code.

## Getting set up

```bash
git clone https://github.com/wevna/wevna.git
cd wevna
pnpm install
pnpm build
pnpm test
```

Requires **Node 22+** and **pnpm 11+**. The repo is a pnpm + Turborepo
monorepo; `pnpm build` at the root builds every package in dependency order.

To see your change running against a real app, `packages/server` has a dev
server (`pnpm --filter @wevna/server dev`) and `examples/` documents the
integration patterns per framework.

## The gate

One command runs exactly what CI runs:

```bash
pnpm turbo run build check test lint
```

If that passes locally it will pass in CI — the release workflow runs the
same four tasks, so there is no path to npm that skips them.
[TESTING.md](TESTING.md) covers what each task actually verifies, plus a
manual end-to-end checklist for changes that automated tests can't reach
(anything involving the dashboard rendering or a real database driver).

Formatting and linting are both Biome: `pnpm lint:fix` fixes what it can.

## Repository layout

Six packages, three of them published:

| Package | Published | What it is |
| --- | --- | --- |
| `wevna` (`packages/sdk`) | yes | The public SDK — `wevna.start()`, instrumentation, plugin host |
| `@wevna/protocol` | yes | The event and recording-file shapes every producer and consumer agrees on |
| `@wevna/plugin-fetch` | yes | Outgoing HTTP capture; also the reference plugin |
| `@wevna/server` | no | The local Fastify server and WebSocket transport |
| `@wevna/dashboard` | no | The React UI, bundled into `wevna` at build time |
| `@wevna/intelligence` | no | Deterministic performance analysis |

The three private packages are bundled into `wevna` rather than published,
which is why the release workflow needs no package list to keep in sync —
`pnpm publish -r` picks up exactly the non-private ones.

[PROJECT_STATUS.md](PROJECT_STATUS.md) is the full architectural handoff:
what was built, what was decided, and why. Read it before proposing anything
structural.

## What we care about in a change

**Wevna runs inside someone else's process, often one step from
production.** Two guarantees follow from that, and they are not negotiable:

- **Wevna never changes what your code does.**
- **Wevna never throws into your code path.**

Concretely, that means any code on the path between a developer's call and
our own bookkeeping needs to contain its own failures. `EventBus.publish`
catches per listener, `PluginManager` quarantines a plugin whose `setup()`
throws, and the WebSocket transport drops an event it cannot serialize
rather than letting `JSON.stringify` escape. If you add a producer or a
subscriber, it inherits that obligation. [STABILITY.md](STABILITY.md) states
the full set of guarantees and — just as importantly — what Wevna
deliberately does *not* promise.

**Capture less than you can.** Recorded data ends up in a file a developer
may share in a bug report. The `pg` instrumentation reads `args[0]` and
never the parameter values; Redis records `command.name` and never the
arguments. When you have a choice, take the narrower one and say why in a
comment.

**Comments explain why, not what.** The existing ones are the house style:
they justify a decision, name the alternative that was rejected, or record
something verified empirically. Match that.

**Tests come with behaviour changes.** Nearly every source module has a
co-located `.test.ts`. A good test here asserts a property rather than an
implementation detail — several bugs in this repo were found *by* tests
written that way, which is documented in `PROJECT_STATUS.md` §7.

## Pull requests

Branch off `main`, keep the change focused, and make sure the gate passes.
CI runs on every PR.

If your change is user-visible, add a line to [CHANGELOG.md](CHANGELOG.md)
under an `## Unreleased` heading. If it changes anything in
[STABILITY.md](STABILITY.md)'s contracts, say so explicitly in the PR
description — `PROTOCOL_VERSION` and `PLUGIN_API_VERSION` are frozen at `1`
for the whole 1.x line, so a change to either is a major-version
conversation, not a patch.

Large or structural changes are much better as an issue first. It's a
cheaper place to find out that something was already tried.

## Releasing

Maintainers only. Publishing happens by pushing a version tag:

```bash
git tag v1.0.1
git push origin v1.0.1
```

`.github/workflows/release.yml` re-runs the full gate and publishes with npm
provenance via OIDC. A laptop cannot produce a provenance attestation, which
is the entire reason releases go through CI rather than `pnpm release`.

## Code of conduct

By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).
