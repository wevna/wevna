# Maintainer TODO

Things only the repository owner can do — credentials, accounts, irreversible
actions. Everything else is tracked in issues and `PROJECT_STATUS.md`.

## Publishing

- [ ] **Release `@wevna/sdk` soon, and publish a GitHub security advisory.** The cross-site WebSocket hijacking / DNS rebinding fix (see `CHANGELOG.md` → Security) closes a hole present in **every published version**: any web page the developer visits can read their live event stream (SQL, requests, logs) from a running Wevna. Worth a patch release (1.1.3) cut from the security fix alone rather than waiting for 1.2.0, and an advisory (Security → Advisories) so users know to upgrade. Edit the "Known issues fixed" wording in `SECURITY.md` to match what you publish.

- [ ] **Merge the stacked PRs in order:** #75 → #76 → #77 → #78 → #79 (each is based on the previous).
- [ ] **npm — new packages need a trusted publisher** (npmjs.com → package → Settings → Trusted publisher, pinned to `wevna/wevna` + `release.yml`), same as the existing three:
  - [ ] `@wevna/plugin-mongodb`
  - [ ] `@wevna/plugin-prisma`
  - [ ] `@wevna/plugin-mysql`
  - Until configured, the first publish falls back to a token and ships **without provenance** (see the comment in `release.yml`).
- [ ] **npm — release `@wevna/sdk` 1.2.0** (ingest endpoint, `wevna` CLI, endpoint ranking, error boundary). Bump the version and tag.
- [ ] **PyPI — create the `wevna` project and a trusted publisher** (pypi.org → Publishing → add a pending publisher: owner `wevna`, repo `wevna`, workflow `release-python.yml`, environment `pypi`), and create a `pypi` environment in the GitHub repo settings. Then publish with `git tag python-v0.1.0 && git push origin python-v0.1.0`. The workflow tests, builds and `twine check`s first, and refuses a tag that doesn't match `pyproject.toml`.
- [ ] Confirm the PyPI name `wevna` is free before announcing it.

## Verification only a human can do

- [ ] Look at the timeline axis fix (#54) in a real browser at a narrow width — it is a CSS container query and jsdom cannot test it.
- [ ] Run the Python SDK against a real Django project (FastAPI and Flask are covered by tests that use the real frameworks; Django's middleware is tested with a stand-in request).
- [ ] Try `@wevna/plugin-mongodb` against a real MongoDB, `@wevna/plugin-prisma` against a real Prisma client and `@wevna/plugin-mysql` against a real MySQL — the tests use structural fakes, as the pg plugin's do.

## Adoption

- [ ] Record a demo GIF/screencast that includes a Python service.
- [ ] Python and plugin sections in the posts drafted in the (gitignored) `*-POST.md` files.
