import { describe, expect, it } from "vitest";
import { DEFAULT_PERFORMANCE_THRESHOLDS } from "./thresholds.js";

describe("DEFAULT_PERFORMANCE_THRESHOLDS", () => {
  it("defines every threshold as a positive number", () => {
    for (const value of Object.values(DEFAULT_PERFORMANCE_THRESHOLDS)) {
      expect(typeof value).toBe("number");
      expect(value).toBeGreaterThan(0);
    }
  });

  // Deliberately exhaustive: the point of this file is that every number
  // deciding whether an insight fires lives here, so a new literal appearing
  // in an analyzer instead should fail here first.
  it("defines exactly the centralized thresholds and no others", () => {
    expect(Object.keys(DEFAULT_PERFORMANCE_THRESHOLDS).sort()).toEqual([
      "dominantCategorySharePercent",
      "longSqlQueryMs",
      "multipleDatabaseCallsCount",
      "multipleRedisOperationsCount",
      "repeatedOperationCount",
      "slowRequestMs",
    ]);
  });
});
