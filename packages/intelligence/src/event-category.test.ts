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
