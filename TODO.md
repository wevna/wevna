# Maintainer TODO

Things only the repository owner can do: credentials, accounts, irreversible
actions, and decisions. Everything else is tracked in issues and
`PROJECT_STATUS.md`. Last refreshed 2026-10-23 against `main` at the merge of #89.

Done since the last version of this file, so it is no longer listed: #80 and #81 (the
security fixes), #82, #84, #85, #86, #87 and #89 are merged.

## 1. The security release (first)

The cross-site WebSocket and DNS rebinding fix is on `main` but not released. It
affects **every published `@wevna/sdk` version**: any web page open in a developer's
browser can read the live event stream from a running Wevna.

- [ ] Review and merge **#90** (release prep: `@wevna/sdk` 1.2.0, `@wevna/protocol` 1.1.0, `@wevna/plugin-fetch` 1.0.1, the SECURITY.md entry).
- [ ] Follow `RELEASE-CHECKLIST.md` at the repository root. It is local and gitignored, and has the exact order. Summary below.
- [ ] After 1.2.0 is on npm, publish the GitHub security advisory from `ADVISORY-DRAFT.md` (also local and gitignored). Patched version 1.2.0. Review the wording and the suggested CVSS vector (`AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:N/A:N`, 6.5, Medium) first.
- [ ] Create a GitHub release for `v1.2.0` that links the advisory.

## 2. npm publishing

`release.yml` runs on a `v*.*.*` tag and publishes every non-private package whose version is not on npm yet. After #90 that is **six** packages. The three plugins have no trusted publisher, so tagging before they are set up would publish the first three and then fail, and published versions cannot be taken back.

- [ ] Configure a GitHub Actions trusted publisher (owner `wevna`, repository `wevna`, workflow `release.yml`, no environment) for each of `@wevna/plugin-mongodb`, `@wevna/plugin-prisma` and `@wevna/plugin-mysql`.
- [ ] **Unknown, check on npmjs.com:** npm's documentation does not say whether a trusted publisher can be added to a package name that has never been published. If the settings page does not exist yet, publish `0.1.0` of that plugin once from your machine (`npm publish --access public --provenance=false`, with your 2FA), then add the trusted publisher. That first version has no provenance.
- [ ] Do this close to tagging. npm expires a new trusted publisher configuration whose first publish does not happen within 2 days.
- [ ] Tag: `git tag v1.2.0 && git push origin v1.2.0`. The release log now has a "Publish plan (dry run)" step that lists what will be attempted. If it lists something unexpected, cancel before the Publish step.
- [ ] Optional hardening, proposed in #90 and not included: an allowlist of publishable packages, and a hard stop when one lacks a trusted publisher.

## 3. PyPI publishing

- [ ] Review and merge **#91** (the release workflow, the dry-run package check, packaging fixes).
- [ ] On PyPI, add a **pending trusted publisher**: owner `wevna`, repository `wevna`, workflow `release-python.yml`, environment `pypi`.
- [ ] Create a GitHub environment named `pypi` (optionally with required reviewers).
- [ ] The name `wevna` returned 404 from PyPI's JSON API on 2026-10-23, so it looks free. That does not prove it can be registered (PyPI also rejects names too close to existing ones). Claim it before announcing.
- [ ] Decide when the Python SDK is ready for a first release. It is alpha and its API is not covered by `STABILITY.md`.
- [ ] Release: `git tag py-v0.1.0 && git push origin py-v0.1.0`. The workflow checks the tag against the package version, tests, builds, verifies the wheel contains the dashboard, installs it in a fresh venv on Python 3.10 and 3.13, and only then publishes.

## 4. Review and merge the other open pull requests

They are independent and branch from `main`, so any order works unless noted.

- [ ] **#92** Python recording and replay. Includes a bug fix (non-finite numbers made invalid JSON). Adds fixtures under `packages/protocol/fixtures/recordings`.
- [ ] **#93** Python WSGI (Flask, Django).
- [ ] **#95** Python: redis-py pipelines. Also changes the shared repeated-command detection in `@wevna/intelligence`.
- [ ] **#96** Python: `requests`.
- [ ] **#97** Python: raw asyncpg. Its tests use a real PostgreSQL if the binaries exist. CI ran them (316 passed, none skipped).
- [ ] **#98** The demo kit. Includes a fix for `instrumentRedis` rejecting a real ioredis client in TypeScript.
- [ ] **#94** The pre-fork design note (needs your decisions, section 6).
- [ ] **#88**, the earlier TODO. Superseded by this file. Close it after this merges.

Several of these edit `CHANGELOG.md` and the Python README, so expect small conflicts after the first merges.

## 5. Verification only a person can do

- [ ] Run the demo with Docker (`pnpm --filter @wevna/example-demo demo`, then `traffic`). It was exercised against a real PostgreSQL and a Redis-protocol server, but `docker compose up` itself was not run. Look at the Repeated Query insight on one order in each dashboard.
- [ ] Look at the timeline axis fix (#54) in a browser at a narrow width. It is a CSS container query that jsdom cannot test, and it was checked at one width only.
- [ ] Try `@wevna/plugin-mongodb`, `@wevna/plugin-prisma` and `@wevna/plugin-mysql` against real servers. The tests use structural fakes. `mysql2` and the `mongodb` driver were checked for wrapping and event shapes, but no database server was available.
- [ ] Run the Python SDK under a real pre-fork server (`gunicorn -w 2`). Confirm the one-line warning appears and memory stays flat.
- [ ] Run a Python recording through the dashboard in your own browser (`wevna.open_recording`). It was checked once in a browser and by tests in both languages.

## 6. Decisions waiting on you

- [ ] **Pre-fork servers (#94).** Is one dashboard per worker acceptable, or is one across workers a requirement? If one: a separate collector (recommended) or first-worker-leads. Port scheme. What a worker that cannot bind should do. Whether a relayed event carries its worker. Independently of the answer, a second worker's `start()` currently stalls for about 6 seconds and prints "running" when it is not; that wants fixing.
- [ ] **Incoming query strings in the Node SDK.** `http.request` events record the incoming URL with its query string (OAuth callbacks, signed URLs, tokens). The Python SDK records the path only. Apply the same redaction rules as outgoing URLs, or record the path only?
- [ ] **Log capture and URLs.** Log capture records what an application's loggers write, and some libraries (httpx, Werkzeug) log full URLs. Documented, not changed. Scrub URLs inside log messages, or leave it as a documented boundary?
- [ ] **`RecordingError`.** Python raises it where the Node loader returns a result object. Keep the Python idiom, or return a structured result in both?
- [ ] **A shared `batch` attribute.** Redis pipeline events carry `batch`, `batchSize` and `batchIndex`, and the repeated-command insight skips them. Make that a documented part of the protocol so the Node SDK can adopt it, or leave it a convention?

## 7. Adoption

- [ ] Record the demo GIF with `examples/demo/RECORDING.md`.
- [ ] Mention the datastore plugins, the Python SDK and the demo in the drafted (gitignored) `*-POST.md` files.
- [ ] Decide whether to announce the security fix alongside the release.
