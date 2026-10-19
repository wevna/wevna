import { describe, expect, it } from "vitest";
import { allowedHostsFor, hostnameOf, isAllowedHost, isAllowedOrigin } from "./host-guard.js";

describe("hostnameOf", () => {
  it.each([
    ["localhost:4123", "localhost"],
    ["LOCALHOST", "localhost"],
    ["127.0.0.1:80", "127.0.0.1"],
    ["[::1]:4123", "::1"],
    ["[::1]", "::1"],
    ["::1", "::1"],
    ["evil.example.com:4123", "evil.example.com"],
  ])("%s -> %s", (input, expected) => {
    expect(hostnameOf(input)).toBe(expected);
  });
});

describe("allowedHostsFor", () => {
  it("is loopback only by default", () => {
    expect(allowedHostsFor("localhost")).toEqual(["localhost", "127.0.0.1", "::1"]);
  });

  it("adds a host the operator bound to", () => {
    expect(allowedHostsFor("devbox.internal")).toContain("devbox.internal");
  });

  it("allows anything when bound to every interface", () => {
    expect(allowedHostsFor("0.0.0.0")).toEqual(["*"]);
    expect(allowedHostsFor("::")).toEqual(["*"]);
  });
});

describe("isAllowedHost", () => {
  const local = allowedHostsFor("localhost");

  it("accepts loopback names and refuses anything else", () => {
    expect(isAllowedHost("localhost:4123", local)).toBe(true);
    expect(isAllowedHost("evil.example.com", local)).toBe(false);
    // A lookalike must not pass a substring check.
    expect(isAllowedHost("localhost.evil.com", local)).toBe(false);
    expect(isAllowedHost("127.0.0.1.evil.com", local)).toBe(false);
  });

  it("lets through a request with no Host: not a browser, and rebinding always sets one", () => {
    expect(isAllowedHost(undefined, local)).toBe(true);
  });
});

describe("isAllowedOrigin", () => {
  const local = allowedHostsFor("localhost");

  it("lets through a request with no Origin (a non-browser client)", () => {
    expect(isAllowedOrigin(undefined, local)).toBe(true);
  });

  it("accepts a local origin on any port and scheme", () => {
    expect(isAllowedOrigin("http://localhost:4123", local)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5173", local)).toBe(true);
    expect(isAllowedOrigin("http://[::1]:3000", local)).toBe(true);
  });

  it("refuses a foreign origin, the sandboxed 'null' origin, and garbage", () => {
    expect(isAllowedOrigin("https://evil.example.com", local)).toBe(false);
    expect(isAllowedOrigin("https://localhost.evil.com", local)).toBe(false);
    expect(isAllowedOrigin("null", local)).toBe(false);
    expect(isAllowedOrigin("not a url", local)).toBe(false);
  });
});
