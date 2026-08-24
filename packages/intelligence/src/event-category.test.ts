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

  // log.record is the Python SDK's logging capture. It shares the "console"
  // category with console.log because the analyzer reports one log count, and
  // a Python request reporting zero logs would be a wrong number rather than
  // a missing feature.
  it("categorizes log.record as console", () => {
    expect(categorizeEvent("log.record")).toBe("console");
  });

  it("categorizes a future log kind as console", () => {
    // Prefix-matched, so a later "log.structured" needs no change here.
    expect(categorizeEvent("log.structured")).toBe("console");
  });

  it("does not swallow an unrelated kind that merely starts with 'log'", () => {
    // "log." with the dot, not "log" — otherwise a hypothetical "logic.step"
    // from a third-party plugin would be miscounted as log output.
    expect(categorizeEvent("logic.step")).toBe("other");
  });
});
