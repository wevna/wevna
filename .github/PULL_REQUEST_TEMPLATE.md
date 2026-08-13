<!--
Thanks for contributing. Keep this short — the diff says most of it.
CONTRIBUTING.md has the full details if you need them.
-->

## What this changes

<!-- One or two sentences. If it fixes an issue, add "Fixes #123". -->

## Why

<!--
The reasoning, not the mechanics. This is the part that's hard to recover
from the diff later, and it's what the house comment style is built around.
-->

## Checklist

- [ ] `pnpm turbo run build check test lint` passes locally
- [ ] Behaviour changes come with tests
- [ ] User-visible changes are noted in `CHANGELOG.md` under `## Unreleased`

## Contracts

<!--
Delete this section if it doesn't apply. PROTOCOL_VERSION and
PLUGIN_API_VERSION are frozen at 1 for the whole 1.x line, so touching either
is a major-version conversation rather than something to slip into a patch.
-->

- [ ] This changes something in `STABILITY.md` — protocol version, plugin API
      version, a public export, or one of the stated guarantees
