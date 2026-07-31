import { describe, expect, it } from "vitest";
import { DEFAULT_PERFORMANCE_THRESHOLDS } from "./thresholds.js";

describe("DEFAULT_PERFORMANCE_THRESHOLDS", () => {
  it("defines every threshold as a positive number", () => {
    for (const value of Object.values(DEFAULT_PERFORMANCE_THRESHOLDS)) {
      expect(typeof value).toBe("number");
      expect(value).toBeGreaterThan(0);
    }
  });

  it("defines exactly the four centralized thresholds", () => {
    expect(Object.keys(DEFAULT_PERFORMANCE_THRESHOLDS).sort()).toEqual([
      "longSqlQueryMs",
      "multipleDatabaseCallsCount",
      "multipleRedisOperationsCount",
      "slowRequestMs",
    ]);
  });
});
