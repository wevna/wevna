# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | ✅ |
| < 1.0 | ❌ |

## Reporting a vulnerability

**Please don't open a public issue for a security problem.**

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/wevna/wevna/security/advisories/new).
That opens a private advisory only the maintainers can see, and it's the
fastest way to reach us.

Please include what you'd need if you were on the receiving end: the version,
what an attacker can actually do, and the smallest reproduction you can
manage. You'll get an acknowledgement within 72 hours and an assessment
within a week. We'll credit you in the advisory unless you'd rather we
didn't.

## Wevna's threat model

Wevna is a **local-first development tool**. It runs inside a developer's own
Node.js process and serves a dashboard on `localhost:4123`. It is not
designed to run in production and does not authenticate the dashboard —
anything that can reach that port can read the captured stream. That is a
deliberate scope decision, not an oversight, and the interesting security
questions follow from it.

Things we consider vulnerabilities:

- **Capture of data Wevna documents that it does not capture.** The
  boundaries are stated in `README.md` and `STABILITY.md` — SQL parameter
  values are never read, Redis command arguments are never recorded, and
  credentials are stripped from URLs before they reach a recording. A path
  that gets any of those into an event or a recording file is a bug worth
  reporting privately.
- **Anything that makes Wevna throw into, or alter, the host application's
  behaviour.** Wevna patches globals (`console.log`,
  `http.Server.prototype.emit`, `fetch`). An input that turns that
  instrumentation into a crash or a change in observable behaviour is in
  scope.
- **Anything reachable from the dashboard's own surface** — a captured value
  that executes as script when rendered, or a request to the local server
  that escapes its intended read-only scope.
- **Anything that lets a recording file, when opened, do more than describe
  itself.**

Things that are *not* vulnerabilities, because they're documented behaviour:

- The dashboard being unauthenticated on `localhost`.
- Plugins not being sandboxed. `STABILITY.md` is explicit that a plugin runs
  with full process privileges; fault isolation is about accidents, not
  malice. Installing a hostile plugin is equivalent to installing a hostile
  dependency.
- `console.log` output appearing in a recording. That's the feature — it's
  formatted through `util.format` and captured as a string.
- URL redaction not being exhaustive. It's best-effort and says so.

If you're unsure which side of that line something falls on, report it
privately anyway. We'd rather triage a non-issue than miss a real one.
