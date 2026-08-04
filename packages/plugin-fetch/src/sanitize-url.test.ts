import { describe, expect, it } from "vitest";
import { describeFetchTarget, REDACTED, sanitizeUrl } from "./sanitize-url.js";

describe("sanitizeUrl", () => {
  it("keeps scheme, host, port and path intact", () => {
    expect(sanitizeUrl("https://api.example.com:8443/v1/orders/42")).toBe(
      "https://api.example.com:8443/v1/orders/42",
    );
  });

  it("keeps non-sensitive query parameters and their values", () => {
    // Stripping these would make the event useless for telling one slow call
    // from another.
    expect(sanitizeUrl("https://api.example.com/orders?page=2&sort=desc")).toBe(
      "https://api.example.com/orders?page=2&sort=desc",
    );
  });

  it("strips userinfo credentials entirely", () => {
    expect(sanitizeUrl("https://alice:s3cr3t@api.example.com/data")).toBe(
      "https://api.example.com/data",
    );
  });

  it("redacts the value but keeps the key for sensitive parameters", () => {
    const sanitized = sanitizeUrl("https://api.example.com/d?api_key=abc123&page=1");

    expect(sanitized).toContain(`api_key=${encodeURIComponent(REDACTED)}`);
    expect(sanitized).toContain("page=1");
    expect(sanitized).not.toContain("abc123");
  });

  it.each([
    "token",
    "access_token",
    "refreshToken",
    "apiKey",
    "API_KEY",
    "x-api-key",
    "secret",
    "client_secret",
    "password",
    "auth",
    "authorization",
    "credential",
    "signature",
    "sig",
  ])("redacts %s regardless of casing or separators", (name) => {
    const sanitized = sanitizeUrl(`https://api.example.com/d?${name}=leaked`);

    expect(sanitized).not.toContain("leaked");
  });

  it("does not redact an innocuous parameter that merely looks similar", () => {
    expect(sanitizeUrl("https://api.example.com/d?keyboard_layout=qwerty")).toContain("qwerty");
  });

  it("redacts every occurrence when a sensitive key repeats", () => {
    const sanitized = sanitizeUrl("https://api.example.com/d?token=one&token=two");

    expect(sanitized).not.toContain("one");
    expect(sanitized).not.toContain("two");
  });

  it("returns an unparseable value unchanged rather than dropping it", () => {
    // An unparseable target is itself worth seeing, and a sanitizer that
    // threw would take down the fetch call it was observing.
    expect(sanitizeUrl("not a url")).toBe("not a url");
    expect(sanitizeUrl("")).toBe("");
  });
});

describe("describeFetchTarget", () => {
  it("defaults to GET for a bare string url", () => {
    expect(describeFetchTarget("https://api.example.com/x")).toEqual({
      method: "GET",
      url: "https://api.example.com/x",
    });
  });

  it("reads the method from init and uppercases it", () => {
    expect(describeFetchTarget("https://api.example.com/x", { method: "post" }).method).toBe(
      "POST",
    );
  });

  it("accepts a URL instance", () => {
    expect(describeFetchTarget(new URL("https://api.example.com/x")).url).toBe(
      "https://api.example.com/x",
    );
  });

  it("reads method and url off a Request-like object", () => {
    expect(describeFetchTarget({ method: "delete", url: "https://api.example.com/x" })).toEqual({
      method: "DELETE",
      url: "https://api.example.com/x",
    });
  });

  it("lets init.method win over a Request's own method, as fetch does", () => {
    expect(
      describeFetchTarget({ method: "GET", url: "https://api.example.com/x" }, { method: "PUT" })
        .method,
    ).toBe("PUT");
  });

  it("sanitizes whichever input form the url came from", () => {
    expect(describeFetchTarget({ url: "https://a:b@api.example.com/x" }).url).toBe(
      "https://api.example.com/x",
    );
  });

  it("degrades to an empty url rather than throwing on unusable input", () => {
    expect(describeFetchTarget(undefined)).toEqual({ method: "GET", url: "" });
    expect(describeFetchTarget(42)).toEqual({ method: "GET", url: "" });
  });
});

// Guards the two-rule split: short generic words like "key" and "sig" are
// matched only as whole words, so ordinary parameters that merely contain
// those letters keep their values.
describe("sanitizeUrl false positives", () => {
  it.each(["keyboard_layout", "monkey_id", "turkey", "sight", "designer", "keyword", "insight_id"])(
    "keeps the value of %s",
    (name) => {
      expect(sanitizeUrl(`https://api.example.com/d?${name}=visible`)).toContain("visible");
    },
  );

  it.each(["key", "keys", "apiKey", "API-KEY", "x_api_key", "sig", "pwd"])(
    "still redacts %s, matched as a whole word",
    (name) => {
      expect(sanitizeUrl(`https://api.example.com/d?${name}=leaked`)).not.toContain("leaked");
    },
  );
});
