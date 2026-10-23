import { describe, expect, it } from "vitest";
import { type Command, filterCommands, matchScore } from "./command-palette.ts";

const command = (id: string, label: string, hint?: string): Command => ({
  id,
  label,
  ...(hint ? { hint } : {}),
  run: () => {},
});

describe("matchScore", () => {
  it("matches an in-order subsequence, case-insensitively", () => {
    expect(matchScore("gor", "GET /orders")).toBeDefined();
    expect(matchScore("GET", "get /orders")).toBeDefined();
  });

  it("rejects characters out of order or missing", () => {
    expect(matchScore("sro", "GET /orders")).toBeUndefined();
    expect(matchScore("xyz", "GET /orders")).toBeUndefined();
  });

  it("scores an empty query as a match for everything", () => {
    expect(matchScore("", "anything")).toBe(0);
  });

  it("prefers an earlier, tighter match", () => {
    expect(matchScore("ord", "orders")).toBeLessThan(matchScore("ord", "GET /old/reorder") ?? 0);
  });

  it("ignores spaces in the query", () => {
    expect(matchScore("get ord", "GET /orders")).toBeDefined();
  });
});

describe("filterCommands", () => {
  const commands = [
    command("a", "Toggle theme"),
    command("b", "GET /orders/:id", "500"),
    command("c", "POST /orders", "201"),
  ];

  it("returns everything in order for an empty query", () => {
    expect(filterCommands(commands, "").map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("filters and ranks by match", () => {
    expect(filterCommands(commands, "post").map((c) => c.id)).toEqual(["c"]);
  });

  it("matches on the hint, so a status code finds its request", () => {
    expect(filterCommands(commands, "500").map((c) => c.id)).toEqual(["b"]);
  });

  it("keeps original order between equal scores", () => {
    const tied = [command("x", "alpha"), command("y", "alpha")];

    expect(filterCommands(tied, "alpha").map((c) => c.id)).toEqual(["x", "y"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterCommands(commands, "zzz")).toEqual([]);
  });
});
