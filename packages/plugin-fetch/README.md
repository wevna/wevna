# @wevna/plugin-fetch

The official [Wevna](https://github.com/wevna/wevna) plugin for outgoing
HTTP instrumentation: captures requests made with the global `fetch` as
`http.client` events, correlated to the incoming request that triggered
them.

Incoming requests were already the most valuable thing Wevna captured.
Outgoing ones are the other half of the same question: a request that spends
400ms waiting on a third-party API looks identical to a slow handler until
you can see the call.

## When you need this

Install it if your app makes outgoing `fetch()` calls (to a third-party
API, a webhook, another internal service) that you want to see in Wevna's
waterfall alongside the incoming request that triggered them. It requires
the `wevna` SDK — this plugin does nothing on its own.

## Install

```bash
npm install @wevna/plugin-fetch
```

## Usage

```ts
import { wevna } from "wevna";
import { createFetchPlugin } from "@wevna/plugin-fetch";

wevna.use(createFetchPlugin());
await wevna.start();
```

Every `fetch()` your application makes from then on appears in the dashboard,
inside the request waterfall it belongs to — and is eligible to be named as
the request's slowest operation, which is usually the point.

To keep a chatty internal dependency out of the stream:

```ts
wevna.use(createFetchPlugin({ ignoreHosts: ["metrics.internal"] }));
```

## What it records

| Attribute | Notes |
| --- | --- |
| `method` | Uppercased. Resolved from a string/`URL`/`Request` input and `init.method` |
| `url` | Sanitized — see below |
| `statusCode` | Present for any completed response, including 4xx/5xx |
| `durationMs` | Measured with `performance.now()` |
| `error` | Present *instead of* `statusCode` when the request never completed (DNS failure, refused connection, abort) |

## What it never records

**No headers, no request body, no response body.** Headers are where
`Authorization` and `Cookie` live, and a body is arbitrary user data — the
same reasoning that keeps Redis command arguments out of `redis.command`
events.

URLs are sanitized before being recorded:

- **userinfo is removed entirely** — `https://user:pass@host/` becomes
  `https://host/`, since that form is credentials by definition.
- **values of sensitive-looking query parameters are replaced** with
  `[redacted]`, while the parameter *name* is kept. Pre-signed URLs, OAuth
  callbacks and webhook endpoints all routinely carry secrets in the query
  string, and "there was an `api_key` here" is useful for debugging while the
  secret itself never is.
- **everything else is kept**, including non-sensitive query values. A URL
  with its path and pagination stripped tells you almost nothing about which
  call was slow, and answering that is the whole point.

Sensitivity uses two rules, because one substring list can't be both safe and
precise. Distinctive words (`token`, `secret`, `password`, `credential`,
`signature`, `auth`) match anywhere in the name, so `authorization` and
`refreshToken` are caught without being listed. Short, common words (`key`,
`sig`, `pwd`) match only as whole words after splitting on separators and
camelCase — so `x-api-key`, `apiKey` and `API_KEY` are all redacted while
`keyboard_layout` and `monkey_id` keep their values.

Nothing here is a guarantee about *your* URLs. It's a conservative default
that assumes secrets show up in conventionally-named parameters; a URL that
puts a token in a path segment will still record it.

## Behaviour notes

- **Never changes your request.** `input` and `init` are passed through
  untouched, the response is returned as-is, and a rejection is rethrown
  unmodified so your own error handling is unaffected.
- **A 4xx/5xx is not an error.** It completed, so it's recorded with its
  status. `error` is reserved for requests that never got a response at all.
- **Teardown only restores `fetch` if nothing else has patched it since.**
  Blindly reassigning would clobber a later wrapper and silently
  un-instrument whatever installed it.
- If the environment has no global `fetch`, the plugin warns once and does
  nothing rather than failing to load.

## Learn more

See the [main Wevna repository](https://github.com/wevna/wevna) for the
SDK, dashboard, and everything else this plugin's events feed into.
