import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { currentCorrelation, runWithCorrelation, startCorrelation } from "./correlation-context.js";

describe("currentCorrelation", () => {
  it("returns undefined when no correlation is active", () => {
    expect(currentCorrelation()).toBeUndefined();
  });
});

describe("startCorrelation", () => {
  it("makes a correlation active for the duration of fn", () => {
    let seenInsideFn: unknown;
    startCorrelation(() => {
      seenInsideFn = currentCorrelation();
    });

    expect(seenInsideFn).toMatchObject({ id: expect.any(String) });
  });

  it("clears the correlation once fn returns", () => {
    startCorrelation(() => {});

    expect(currentCorrelation()).toBeUndefined();
  });

  it("generates a different id on each call", () => {
    let first: unknown;
    let second: unknown;
    startCorrelation(() => {
      first = currentCorrelation();
    });
    startCorrelation(() => {
      second = currentCorrelation();
    });

    expect(first).not.toEqual(second);
  });

  it("returns fn's return value", () => {
    const result = startCorrelation(() => 42);

    expect(result).toBe(42);
  });

  it("keeps the same correlation across nested synchronous calls", () => {
    let outer: unknown;
    let inner: unknown;

    startCorrelation(() => {
      outer = currentCorrelation();
      function nested() {
        inner = currentCorrelation();
      }
      nested();
    });

    expect(inner).toEqual(outer);
  });

  it("keeps the same correlation across an awaited async boundary", async () => {
    let before: unknown;
    let after: unknown;

    await startCorrelation(async () => {
      before = currentCorrelation();
      await delay(1);
      after = currentCorrelation();
    });

    expect(after).toEqual(before);
  });

  it("keeps the same correlation across multiple sequential async hops", async () => {
    const seen: unknown[] = [];

    await startCorrelation(async () => {
      seen.push(currentCorrelation());
      await delay(1);
      seen.push(currentCorrelation());
      await Promise.resolve();
      seen.push(currentCorrelation());
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(currentCorrelation());
    });

    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
    expect(seen[3]).toEqual(seen[0]);
  });

  it("keeps the same correlation inside a callback registered during fn but invoked later", async () => {
    let registered: unknown;
    let invoked: unknown;

    await new Promise<void>((testDone) => {
      startCorrelation(() => {
        registered = currentCorrelation();
        setImmediate(() => {
          invoked = currentCorrelation();
          testDone();
        });
      });
    });

    expect(invoked).toEqual(registered);
  });

  it("isolates concurrent correlations from each other (no leaking, no mixing)", async () => {
    const results: { label: string; seen: unknown[] }[] = [];

    async function run(label: string): Promise<void> {
      const seen: unknown[] = [];
      await startCorrelation(async () => {
        seen.push(currentCorrelation());
        await delay(Math.random() * 5);
        seen.push(currentCorrelation());
        await delay(Math.random() * 5);
        seen.push(currentCorrelation());
      });
      results.push({ label, seen });
    }

    await Promise.all([run("a"), run("b"), run("c"), run("d")]);

    for (const { seen } of results) {
      expect(seen[1]).toEqual(seen[0]);
      expect(seen[2]).toEqual(seen[0]);
    }
    const ids = results.map((r) => (r.seen[0] as { id: string }).id);
    expect(new Set(ids).size).toBe(4);
  });

  it("does not leak into code that runs after fn returns, even concurrently", async () => {
    const outerCorrelationDuringConcurrentWork: unknown[] = [];

    const inner = startCorrelation(async () => {
      await delay(5);
    });
    // Nothing here is inside the correlation — verifies isolation from the
    // caller's perspective, not just between two startCorrelation() calls.
    outerCorrelationDuringConcurrentWork.push(currentCorrelation());
    await inner;

    expect(outerCorrelationDuringConcurrentWork[0]).toBeUndefined();
  });
});

describe("runWithCorrelation", () => {
  it("runs fn under the given correlation rather than a new one", () => {
    const correlation = { id: "known-id" };
    let seen: unknown;

    runWithCorrelation(correlation, () => {
      seen = currentCorrelation();
    });

    expect(seen).toEqual(correlation);
  });

  it("propagates the given correlation across async boundaries the same way startCorrelation does", async () => {
    const correlation = { id: "known-id" };
    let after: unknown;

    await runWithCorrelation(correlation, async () => {
      await delay(1);
      after = currentCorrelation();
    });

    expect(after).toEqual(correlation);
  });

  it("clears the correlation once fn returns", () => {
    runWithCorrelation({ id: "known-id" }, () => {});

    expect(currentCorrelation()).toBeUndefined();
  });
});
