// Query parameter names whose *values* are redacted. Two rules rather than
// one, because a single substring list cannot be both safe and precise.
//
// An outgoing request URL is the one place credentials routinely end up
// looking like harmless metadata: pre-signed URLs, OAuth callbacks and
// webhook endpoints all carry secrets in the query string. Keys are kept
// while values are replaced, because "there was an api_key here" is useful
// for debugging and the secret itself never is.

// Distinctive enough that appearing anywhere in the name is proof of intent.
// "authorization" and "refreshToken" are caught here without being listed.
const SENSITIVE_SUBSTRINGS = [
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "signature",
  "auth",
];

// Too short or too common to match as substrings — "key" would redact
// `keyboard_layout` and `monkey_id`, "sig" would redact `sight`. Matched
// only as a whole word within the name, after splitting on separators and
// camelCase, so `x-api-key`, `apiKey` and `API_KEY` are all covered while
// `keyboard_layout` is not.
const SENSITIVE_WORDS = new Set(["key", "keys", "sig", "apikey", "pwd"]);

export const REDACTED = "[redacted]";

function words(name: string): string[] {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function isSensitive(name: string): boolean {
  const collapsed = name.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  if (SENSITIVE_SUBSTRINGS.some((pattern) => collapsed.includes(pattern))) {
    return true;
  }
  return words(name).some((word) => SENSITIVE_WORDS.has(word));
}

// Reduces an outgoing request URL to something safe to record and still
// useful to read.
//
// Two things are always removed: userinfo (the user:pass@ form, which is
// credentials by definition) and the values of sensitive-looking query
// parameters. Everything else — scheme, host, port, path, and non-sensitive
// query keys *and* values — is kept, because a url with its path and
// pagination stripped out tells you almost nothing about which call was
// slow, and the point of capturing outgoing requests at all is to answer
// exactly that.
//
// Never throws: a value that isn't a parseable URL is returned unchanged
// rather than dropped, since an unparseable target is itself worth seeing,
// and a sanitizer that threw would take down the fetch call it was
// observing.
export function sanitizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  parsed.username = "";
  parsed.password = "";

  for (const name of [...parsed.searchParams.keys()]) {
    if (isSensitive(name)) {
      parsed.searchParams.set(name, REDACTED);
    }
  }

  return parsed.toString();
}

// The method/url pair for whatever fetch was called with. fetch accepts a
// string, a URL, or a Request, and only the last carries its own method —
// resolving all three here keeps that branching out of the instrumentation
// itself.
export function describeFetchTarget(
  input: unknown,
  init?: { method?: string } | undefined,
): { method: string; url: string } {
  if (typeof input === "string") {
    return { method: init?.method?.toUpperCase() ?? "GET", url: sanitizeUrl(input) };
  }
  if (input instanceof URL) {
    return { method: init?.method?.toUpperCase() ?? "GET", url: sanitizeUrl(input.toString()) };
  }
  if (input && typeof input === "object") {
    const request = input as { method?: unknown; url?: unknown };
    const method =
      init?.method ?? (typeof request.method === "string" ? request.method : undefined) ?? "GET";
    const url = typeof request.url === "string" ? sanitizeUrl(request.url) : "";
    return { method: method.toUpperCase(), url };
  }
  return { method: init?.method?.toUpperCase() ?? "GET", url: "" };
}
