import { describe, expect, it } from "vitest";
import { getEventKindCategory } from "./event-kind-category.ts";

describe("getEventKindCategory", () => {
  it("categorizes http.* kinds as http", () => {
    expect(getEventKindCategory("http.request")).toBe("http");
  });

  it("categorizes sql.* kinds as sql", () => {
    expect(getEventKindCategory("sql.query")).toBe("sql");
  });

  it("categorizes redis.* kinds as redis", () => {
    expect(getEventKindCategory("redis.command")).toBe("redis");
  });

  it("falls back to other for console.log", () => {
    expect(getEventKindCategory("console.log")).toBe("other");
  });

  it("falls back to other for an unrecognized future kind", () => {
    expect(getEventKindCategory("bullmq.job")).toBe("other");
  });

  it("is deterministic for the same input", () => {
    expect(getEventKindCategory("sql.query")).toBe(getEventKindCategory("sql.query"));
  });
});
