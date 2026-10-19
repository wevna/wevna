# Maintainer TODO

Things only the repository owner can do — credentials, accounts, irreversible
actions. Everything else is tracked in issues and `PROJECT_STATUS.md`.

## Publishing

- [ ] **Merge the stacked PRs in order:** #75 → #76 → #77 (each is based on the previous).
- [ ] **npm — new packages need a trusted publisher** (npmjs.com → package → Settings → Trusted publisher, pinned to `wevna/wevna` + `release.yml`), same as the existing three:
  - [ ] `@wevna/plugin-mongodb`
  - [ ] `@wevna/plugin-prisma`
  - Until configured, the first publish falls back to a token and ships **without provenance** (see the comment in `release.yml`).
- [ ] **npm — release `@wevna/sdk` 1.2.0** (ingest endpoint, `wevna` CLI, endpoint ranking, error boundary). Bump the version and tag.
- [ ] **PyPI — create the `wevna` project and a trusted publisher** (pypi.org → Publishing), then add a `python/` release workflow. Not written yet because it needs that account to exist; ask and it will be drafted.
- [ ] Confirm the PyPI name `wevna` is free before announcing it.

## Verification only a human can do

- [ ] Look at the timeline axis fix (#54) in a real browser at a narrow width — it is a CSS container query and jsdom cannot test it.
- [ ] Run the Python SDK against a real FastAPI and a real Flask app (the tests use hand-built ASGI/WSGI calls, not the frameworks).
- [ ] Try `@wevna/plugin-mongodb` against a real MongoDB and `@wevna/plugin-prisma` against a real Prisma client — the tests use structural fakes, as the pg plugin's do.

## Adoption

- [ ] Record a demo GIF/screencast that includes a Python service.
- [ ] Python and plugin sections in the posts drafted in the (gitignored) `*-POST.md` files.
