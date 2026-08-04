import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { describe, expect, it } from "vitest";
import type { AnalyzableRequest, AnalyzableTimelineEntry } from "./analyzable-request.js";
import { detectRepeatedOperations, normalizeSqlShape } from "./detect-repetition.js";

let sequence = 0;

function makeEntry(overrides: {
  kind: string;
  attributes?: Record<string, unknown>;
  durationMs?: number;
}): AnalyzableTimelineEntry {
  sequence += 1;
  const event: Envelope<CapturedEvent> = {
    version: 1,
    sessionId: "session-1",
    sequence,
    payload: {
      id: `event-${sequence}`,
      kind: overrides.kind,
      occurredAt: sequence,
      attributes: overrides.attributes ?? {},
    },
  };
  return {
    kind: overrides.kind,
    relativeOffsetMs: sequence,
    durationMs: overrides.durationMs,
    event,
  };
}

function requestOf(timeline: readonly AnalyzableTimelineEntry[]): AnalyzableRequest {
  return { durationMs: 100, timeline };
}

function sqlEntry(query: string, durationMs = 2) {
  return makeEntry({ kind: "sql.query", attributes: { query }, durationMs });
}

describe("normalizeSqlShape", () => {
  it("collapses differing numeric literals to one shape", () => {
    expect(normalizeSqlShape("SELECT * FROM users WHERE id = 1")).toBe(
      normalizeSqlShape("SELECT * FROM users WHERE id = 2"),
    );
  });

  it("collapses differing string literals to one shape", () => {
    expect(normalizeSqlShape("SELECT * FROM u WHERE email = 'a@b.com'")).toBe(
      normalizeSqlShape("SELECT * FROM u WHERE email = 'c@d.com'"),
    );
  });

  it("treats a parameterized query and an interpolated one as the same shape", () => {
    expect(normalizeSqlShape("SELECT * FROM u WHERE id = $1")).toBe(
      normalizeSqlShape("SELECT * FROM u WHERE id = 7"),
    );
  });

  it("collapses IN lists of different lengths", () => {
    expect(normalizeSqlShape("SELECT * FROM u WHERE id IN (1, 2, 3)")).toBe(
      normalizeSqlShape("SELECT * FROM u WHERE id IN (9)"),
    );
  });

  it("normalizes whitespace and casing", () => {
    expect(normalizeSqlShape("SELECT   *\n  FROM users")).toBe("select * from users");
  });

  it("keeps digits that are part of an identifier distinct", () => {
    // users_2024 and users_2023 are different tables, not one shape.
    expect(normalizeSqlShape("SELECT * FROM users_2024")).not.toBe(
      normalizeSqlShape("SELECT * FROM users_2023"),
    );
  });

  it("keeps genuinely different queries distinct", () => {
    expect(normalizeSqlShape("SELECT * FROM users WHERE id = 1")).not.toBe(
      normalizeSqlShape("SELECT * FROM orders WHERE id = 1"),
    );
  });

  it("never leaks an interpolated literal into the shape", () => {
    // The signature is displayed in the dashboard, so this is a safety
    // property and not only a grouping one.
    expect(normalizeSqlShape("SELECT * FROM u WHERE token = 'super-secret'")).not.toContain(
      "super-secret",
    );
  });
});

describe("detectRepeatedOperations", () => {
  it("reports nothing for a request with no repetition", () => {
    expect(
      detectRepeatedOperations(
        requestOf([sqlEntry("SELECT 1"), sqlEntry("SELECT 2 FROM orders")]),
        3,
      ),
    ).toEqual([]);
  });

  it("detects the same query shape run repeatedly, with count and total time", () => {
    const repeated = detectRepeatedOperations(
      requestOf([
        sqlEntry("SELECT * FROM users WHERE id = 1", 3),
        sqlEntry("SELECT * FROM users WHERE id = 2", 4),
        sqlEntry("SELECT * FROM users WHERE id = 3", 5),
      ]),
      3,
    );

    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({ kind: "sql.query", count: 3, totalDurationMs: 12 });
    expect(repeated[0]?.signature).toBe("select * from users where id = ?");
  });

  it("respects the minimum count, so a deliberate pair is not flagged", () => {
    const pair = requestOf([sqlEntry("SELECT 1 FROM u"), sqlEntry("SELECT 2 FROM u")]);

    expect(detectRepeatedOperations(pair, 3)).toEqual([]);
    expect(detectRepeatedOperations(pair, 2)).toHaveLength(1);
  });

  it("groups Redis commands by name", () => {
    const repeated = detectRepeatedOperations(
      requestOf([
        makeEntry({ kind: "redis.command", attributes: { command: "GET" }, durationMs: 1 }),
        makeEntry({ kind: "redis.command", attributes: { command: "get" }, durationMs: 1 }),
        makeEntry({ kind: "redis.command", attributes: { command: "GET" }, durationMs: 1 }),
      ]),
      3,
    );

    expect(repeated[0]).toMatchObject({ kind: "redis.command", signature: "get", count: 3 });
  });

  it("keeps SQL and Redis repetition as separate findings", () => {
    const repeated = detectRepeatedOperations(
      requestOf([
        ...Array.from({ length: 3 }, () => sqlEntry("SELECT 1 FROM u")),
        ...Array.from({ length: 4 }, () =>
          makeEntry({ kind: "redis.command", attributes: { command: "get" }, durationMs: 1 }),
        ),
      ]),
      3,
    );

    expect(repeated.map((r) => r.kind)).toEqual(["redis.command", "sql.query"]);
  });

  it("orders findings by descending count", () => {
    const repeated = detectRepeatedOperations(
      requestOf([
        ...Array.from({ length: 3 }, () => sqlEntry("SELECT a FROM u")),
        ...Array.from({ length: 5 }, () => sqlEntry("SELECT b FROM o")),
      ]),
      3,
    );

    expect(repeated.map((r) => r.count)).toEqual([5, 3]);
  });

  it("ignores kinds with no meaningful signature", () => {
    expect(
      detectRepeatedOperations(
        requestOf([
          makeEntry({ kind: "console.log" }),
          makeEntry({ kind: "console.log" }),
          makeEntry({ kind: "console.log" }),
        ]),
        3,
      ),
    ).toEqual([]);
  });

  it("ignores a sql.query with no usable query text", () => {
    expect(
      detectRepeatedOperations(
        requestOf([
          makeEntry({ kind: "sql.query", attributes: { query: "  " } }),
          makeEntry({ kind: "sql.query", attributes: {} }),
          makeEntry({ kind: "sql.query", attributes: { query: 42 } }),
        ]),
        2,
      ),
    ).toEqual([]);
  });

  it("counts an entry with no measured duration without corrupting the total", () => {
    const repeated = detectRepeatedOperations(
      requestOf([
        sqlEntry("SELECT 1 FROM u", 2),
        makeEntry({ kind: "sql.query", attributes: { query: "SELECT 2 FROM u" } }),
        sqlEntry("SELECT 3 FROM u", 3),
      ]),
      3,
    );

    expect(repeated[0]).toMatchObject({ count: 3, totalDurationMs: 5 });
  });

  it("is deterministic for the same input", () => {
    const build = () =>
      detectRepeatedOperations(
        requestOf([
          ...Array.from({ length: 3 }, () => sqlEntry("SELECT a FROM u", 1)),
          ...Array.from({ length: 3 }, () => sqlEntry("SELECT b FROM o", 1)),
        ]),
        3,
      );

    expect(build()).toEqual(build());
  });
});
