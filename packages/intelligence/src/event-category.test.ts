import { describe, expect, it } from "vitest";
import { categorizeEvent } from "./event-category.js";

describe("categorizeEvent", () => {
  it("categorizes http.* kinds as http", () => {
    expect(categorizeEvent("http.request")).toBe("http");
  });

  it("categorizes sql.* kinds as sql", () => {
    expect(categorizeEvent("sql.query")).toBe("sql");
  });

  it("categorizes redis.* kinds as redis", () => {
    expect(categorizeEvent("redis.command")).toBe("redis");
  });

  it("categorizes exception.* kinds as exception", () => {
    expect(categorizeEvent("exception.captured")).toBe("exception");
  });

  it("categorizes console.* kinds as console", () => {
    expect(categorizeEvent("console.log")).toBe("console");
  });

  it("falls back to other for an unrecognized future kind", () => {
    expect(categorizeEvent("bullmq.job")).toBe("other");
  });

  it("is deterministic for the same input", () => {
    expect(categorizeEvent("sql.query")).toBe(categorizeEvent("sql.query"));
  });
});

// Outgoing HTTP must never land in the same bucket as the incoming request:
// http.request's duration contains the whole request, while an http.client
// call is one operation inside it, so summing them would make the http
// total exceed the request's own duration.
describe("categorizeEvent outgoing HTTP", () => {
  it("classifies http.client separately from http.request", () => {
    expect(categorizeEvent("http.client")).toBe("httpClient");
    expect(categorizeEvent("http.request")).toBe("http");
  });

  it("classifies future http.client.* kinds as outgoing too", () => {
    expect(categorizeEvent("http.client.retry")).toBe("httpClient");
  });

  it("does not mistake another http kind for an outgoing call", () => {
    expect(categorizeEvent("http.upgrade")).toBe("http");
  });
});
