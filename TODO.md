# Maintainer TODO

Things only the repository owner can do: credentials, accounts, irreversible
actions, and decisions. Everything else is tracked in issues and
`PROJECT_STATUS.md`. Last refreshed 2026-10-23 against `main` at the merge of #100.

This replaces the TODO proposed in #88. What #88 listed is either done (#80 to #87
and #89 are merged), carried over below, or superseded (#93 is the WSGI adapter #88
asked for).

## 1. Merge the open pull requests, in this order

Each one was brought up to date with `main` and passes the full gate on its own. All
of them together, merged in this order, also pass (checked on a local branch that was
not pushed). After each merge, the next one may show a small conflict in
`CHANGELOG.md`, `README.md` or the Python README; both sides of those conflicts are
kept.

- [ ] **#101** Removes `.pyc` files and an egg-info directory committed by mistake.
- [ ] **#102** A CI check that fails if a draft post, a work report or build output is
  tracked. Needs #101 first, or its check fails on the files #101 removes.
- [ ] **#98** The demo kit. Also fixes `instrumentRedis(new Redis(url))` not
  type-checking, which ships in `@wevna/sdk`, so it goes before the release.
- [ ] **#90** Release prep: `@wevna/sdk` 1.2.0, `@wevna/protocol` 1.1.0,
  `@wevna/plugin-fetch` 1.0.1, the SECURITY.md entry. Merging it does not publish
  anything; the tag does (section 2).
- [ ] **#91** Python release workflow, dry-run package check, packaging fixes.
- [ ] **#92** Python recording and replay.
- [ ] **#93** Python WSGI (Flask, Django).
- [ ] **#95** Python redis-py pipelines. Also changes repeated-command detection in
  `@wevna/intelligence`.
- [ ] **#96** Python `requests`.
- [ ] **#97** Python raw asyncpg.
- [ ] **#94** The pre-fork design note (decisions in section 6).
- [ ] **#99** This file, `PROJECT_STATUS.md` and the README capture table. Last,
  because the table describes `main` after everything above.
- [ ] **#88** Close it. Superseded by this file.
- [ ] Delete the remote branches of the closed relay prototype (#77, #78) once #93
  is merged, if nothing else needs them.

## 2. The security release, then npm

The cross-site WebSocket and DNS rebinding fix is on `main` but not released. It
affects **every published `@wevna/sdk` version**: any web page open in a developer's
browser can read the live event stream from a running Wevna.

`release.yml` runs on a `v*.*.*` tag and publishes every non-private package whose
version is not on npm yet. After #90 that is **six** packages. It has no npm token,
only trusted publishing, so a package without a trusted publisher fails, and the
packages published before it in the same run stay published.

- [ ] Configure a GitHub Actions trusted publisher (owner `wevna`, repository
  `wevna`, workflow `release.yml`, no environment) for `@wevna/plugin-mongodb`,
  `@wevna/plugin-prisma` and `@wevna/plugin-mysql`.
- [ ] **Unknown, check on npmjs.com:** npm's documentation does not say whether a
  trusted publisher can be added to a package name that has never been published. If
  the settings page does not exist yet, publish `0.1.0` of that plugin once from your
  machine (`npm publish --access public --provenance=false`, with your 2FA), then add
  the trusted publisher. That first version has no provenance.
- [ ] Do this close to tagging. npm expires a new trusted publisher configuration
  whose first publish does not happen within 2 days.
- [ ] Tag: `git tag v1.2.0 && git push origin v1.2.0`. The release log has a
  "Publish plan (dry run)" step that lists what will be attempted. If it lists
  something unexpected, cancel before the Publish step.
- [ ] After 1.2.0 is on npm, publish a GitHub security advisory. Patched version
  1.2.0. A suggested CVSS vector: `AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:N/A:N` (6.5,
  Medium). Make the "Known issues fixed" entry in `SECURITY.md` match its wording.
- [ ] Create a GitHub release for `v1.2.0` that links the advisory.
- [ ] Optional hardening, proposed in #90 and not included: an allowlist of
  publishable packages, and a hard stop when one lacks a trusted publisher.

An earlier session wrote `RELEASE-CHECKLIST.md` and `ADVISORY-DRAFT.md` as local,
gitignored files. They were never committed, so they exist only on the machine that
wrote them. The steps above are enough without them.

## 3. PyPI publishing

- [ ] On PyPI, add a **pending trusted publisher**: owner `wevna`, repository
  `wevna`, workflow `release-python.yml`, environment `pypi`.
- [ ] Create a GitHub environment named `pypi` (optionally with required reviewers).
- [ ] The name `wevna` returned 404 from PyPI's JSON API on 2026-10-23, so it looks
  free. That does not prove it can be registered (PyPI also rejects names too close
  to existing ones). Claim it before announcing.
- [ ] Decide when the Python SDK is ready for a first release. It is alpha and its API
  is not covered by `STABILITY.md`.
- [ ] Release: `git tag py-v0.1.0 && git push origin py-v0.1.0`. The workflow checks
  the tag against the package version, builds, checks that the wheel contains the
  dashboard and no compiled files, installs it in a fresh venv on Python 3.10 and
  3.13, and only then publishes.

## 4. Verification

Done on 2026-10-23 (details in `PROJECT_STATUS.md`, section 10):

- [x] The Python SDK under `gunicorn -w 2`: the forked-worker warning appears once per
  worker with `--preload`, and worker memory stays flat over 9,000 requests.
- [x] `@wevna/plugin-mongodb` against MongoDB 7 and `@wevna/plugin-mysql` against
  MySQL 8.4. Two gaps found, listed in section 6.
- [x] The demo with `docker compose` and the traffic script.
- [x] A Python recording replayed in the dashboard, in headless Chromium.
- [x] Flask and Django through the WSGI middleware, with real servers.

Still needs a person:

- [ ] Look at the timeline axis fix (#54) in a browser at a narrow width. It is a CSS
  container query that jsdom cannot test, and it was checked at one width only.
- [ ] Try `@wevna/plugin-prisma` against a real Prisma client. Not run.
- [ ] Watch a replay in your own browser at normal speed, to judge it as a user
  would. The headless check only proves it works.

## 5. Adoption

- [ ] Record the demo GIF with `examples/demo/RECORDING.md`. It includes a Python
  service.
- [ ] Mention the datastore plugins, the Python SDK and the demo in the drafted
  (gitignored) `*-POST.md` files.
- [ ] Decide whether to announce the security fix alongside the release.

## 6. Decisions waiting on you

- [ ] **Pre-fork servers (#94).** Is one dashboard per worker acceptable, or is one
  across workers a requirement? If one: a separate collector (recommended) or
  first-worker-leads. Port scheme. What a worker that cannot bind should do. Whether a
  relayed event carries its worker. Independently of the answer, a second worker's
  `start()` stalls for about 5 seconds and prints "Wevna running" when it is not.
  That was reproduced under `gunicorn -w 2` and wants fixing.
- [ ] **MongoDB write errors.** A failed write (a duplicate key, for example) comes
  back as `ok: 1` with `writeErrors`, and the plugin reports it as a success. Fix it
  in a follow-up by recording the write error's code (never its message, which quotes
  the duplicate value)?
- [ ] **MySQL pool connections.** `instrument(pool)` does not cover connections taken
  with `pool.getConnection()`. Wrap `getConnection` too, or document that each such
  connection is passed to `instrument()`?
- [ ] **Incoming query strings in the Node SDK.** `http.request` events record the
  incoming URL with its query string (OAuth callbacks, signed URLs, tokens). The
  Python SDK records the path only. Apply the same redaction rules as outgoing URLs,
  or record the path only?
- [ ] **Redis error messages.** Redis errors have no code, so the message is recorded.
  "unknown command" errors quote the start of the arguments. Keep, or record only
  the first word of the message (`ERR`, `WRONGTYPE`)?
- [ ] **Log capture and URLs.** Log capture records what an application's loggers
  write, and some libraries (httpx, Werkzeug) log full URLs. Documented, not changed.
  Scrub URLs inside log messages, or leave it as a documented boundary?
- [ ] **`RecordingError`.** Python raises it where the Node loader returns a result
  object. Keep the Python idiom, or return a structured result in both?
- [ ] **A shared `batch` attribute.** Redis pipeline events carry `batch`,
  `batchSize` and `batchIndex`, and the repeated-command insight skips them. Make that
  a documented part of the protocol so the Node SDK can adopt it, or leave it a
  convention?
- [ ] **The Python sdist ships the tests.** Usual for an sdist, and the wheel does
  not. Keep, or exclude them?
- [ ] **WSGI `file_wrapper`.** The middleware wraps every response body, so a server's
  `sendfile` fast path for `wsgi.file_wrapper` responses is not used while Wevna is
  installed. The bytes sent are the same. Pass file responses through unwrapped (and
  lose the end-of-request timing for them), or leave it?
