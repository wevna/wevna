# Maintainer TODO

Things only the repository owner can do — credentials, accounts, irreversible
actions. Everything else is tracked in issues and `PROJECT_STATUS.md`.

## Security — do this first

- [ ] **Merge #80 (Node) and #81 (Python), then release `@wevna/sdk` 1.1.3 and publish a GitHub security advisory.** Any web page open in a developer's browser could connect to `ws://localhost:4123/ws` and read the live event stream (SQL, requests, logs) from a running Wevna — cross-site WebSocket hijacking, plus DNS rebinding for HTTP. It affects **every published `@wevna/sdk` version**. The Python server had the same hole but is unpublished, so #81 only needs to land before its first release. Cut 1.1.3 from #80 alone rather than waiting for the rest. Edit `SECURITY.md` ("Known issues fixed") to match the advisory wording. #80 and #81 share `packages/server/fixtures/host-guard.json`, an identical file in both, which merges cleanly in either order.

## Merging the open PRs

Independent, off `main` — merge in any order:
- [ ] #80, #81 (security, above)
- [ ] #82 — #54 layout nits, #48 cleanups, the sanitizer fixture kept in step with the Python port
- [ ] #84 — dashboard shortcuts and command palette
- [ ] #85, #86, #87 — Python SDK: thread-safe sequence numbers + `correlation.bind`, `port=0`, forked-worker memory leak

Stacked: **#83** (MongoDB / Prisma / MySQL plugins + `database` category) is based on #82 — merge #82 first, then retarget #83 to `main` (GitHub does this automatically if you merge #82 with "delete branch").

## Publishing

- [ ] **npm — new packages need a trusted publisher** (npmjs.com → package → Settings → Trusted publisher, pinned to `wevna/wevna` + `release.yml`), same as the existing three. Until configured, the first publish falls back to a token and ships **without provenance** (see the comment in `release.yml`):
  - [ ] `@wevna/plugin-mongodb`
  - [ ] `@wevna/plugin-prisma`
  - [ ] `@wevna/plugin-mysql`
- [ ] **npm — release `@wevna/sdk` 1.2.0** (shortcuts, command palette, database category, endpoint ranking, error boundary) after the PRs above merge.
- [ ] **PyPI — first release of the Python SDK** (`python/wevna`, currently alpha / unpublished). Needs the `wevna` project created and a trusted publisher; there is no Python release workflow yet. Confirm the name `wevna` is free before announcing it.

## Verification only a human can do

- [ ] Look at the timeline axis fix (#54) in a real browser at a narrow width — it is a CSS container query and jsdom cannot test it. (It was checked at one width in Chrome; the narrow case could not be reached from automation.)
- [ ] Try `@wevna/plugin-mongodb` against a real MongoDB, `@wevna/plugin-prisma` against a real Prisma client and `@wevna/plugin-mysql` against a real MySQL. The tests use structural fakes (as the `pg` support does); `mysql2` and the `mongodb` driver were checked for wrapping and event field names, but no database server was available.
- [ ] Run the Python SDK under a real pre-fork server (`gunicorn -w 2`) and confirm the one-line warning from #87 appears and memory stays flat.

## Decisions waiting on you

- [ ] **Pre-fork servers and the Python dashboard.** Under `gunicorn -w N` / `uvicorn --workers N` only the process that called `start()` hosts the dashboard; forked workers' events are dropped (#87 makes that safe and says so). Capturing every worker would need a design: either each worker hosts its own dashboard on its own port, or workers relay to one. Not a bug fix, so not done.
- [ ] **A WSGI adapter for the Python SDK** (Flask, Django). The self-hosted SDK is ASGI-only. A relay-based prototype had one (closed PRs #77/#78, branches kept on the remote); it would need redoing against the self-hosted design.

## Adoption

- [ ] Record a demo GIF/screencast — ideally one that includes a Python service.
- [ ] Mention the plugins and the Python SDK in the drafted (gitignored) `*-POST.md` files.
