// Defences against a web page you happen to be visiting talking to the Wevna
// server on localhost. Two distinct attacks, two checks.
//
// 1. Cross-site WebSocket hijacking. Browsers do not apply the same-origin
//    policy to WebSockets, so any page can open ws://localhost:4123/ws and
//    read every SQL query, request and log line the dashboard shows. The
//    browser does send an Origin header, so the server must refuse one that is
//    not local.
//
// 2. DNS rebinding. An attacker's own hostname is briefly pointed at
//    127.0.0.1, which makes requests to the server *same-origin* for the page:
//    no preflight, readable responses, and Origin equal to the attacker's
//    host. The Host header is then the attacker's name, not a local one, so
//    refusing unknown Hosts closes it.
//
// Non-browser clients (the Python SDK, curl, a Node script) send no Origin and
// a local Host, and pass both.

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "::1"];
const WILDCARD_BIND_ADDRESSES = new Set(["0.0.0.0", "::", "[::]", ""]);

// The hostnames a request may address the server by, given what it was bound
// to. Loopback names always; the bound host too if the operator chose
// something else (a dev box's name). Binding to every interface is a
// deliberate decision to be reachable, so any Host is accepted there — the
// operator opted out of local-only.
export function allowedHostsFor(boundHost: string | undefined): string[] {
  if (boundHost !== undefined && WILDCARD_BIND_ADDRESSES.has(boundHost)) {
    return ["*"];
  }
  const hosts = [...LOOPBACK_HOSTNAMES];
  if (boundHost !== undefined && !hosts.includes(boundHost)) {
    hosts.push(boundHost);
  }
  return hosts;
}

// "localhost:4123" -> "localhost", "[::1]:4123" -> "::1", "[::1]" -> "::1".
export function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(1, end);
  }
  const colon = value.lastIndexOf(":");
  // An unbracketed value with more than one colon is a bare IPv6 address.
  return colon !== -1 && value.indexOf(":") === colon ? value.slice(0, colon) : value;
}

function isAllowed(hostname: string, allowed: readonly string[]): boolean {
  return allowed.includes("*") || allowed.includes(hostname);
}

export function isAllowedHost(hostHeader: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.includes("*")) {
    return true;
  }
  // No Host at all (HTTP/1.0, injected test requests) cannot come from a
  // browser, and rebinding always carries the attacker's hostname — so only a
  // Host that is present and foreign is refused.
  return hostHeader === undefined || isAllowed(hostnameOf(hostHeader), allowed);
}

// An absent Origin is fine (not a browser). A present one must name an
// allowed host; "null" (sandboxed iframes, file://) never does.
export function isAllowedOrigin(
  originHeader: string | undefined,
  allowed: readonly string[],
): boolean {
  if (originHeader === undefined || allowed.includes("*")) {
    return true;
  }
  try {
    return isAllowed(hostnameOf(new URL(originHeader).host), allowed);
  } catch {
    return false;
  }
}
