import type { RequestModel } from "@wevna/intelligence";
import { describe, expect, it } from "vitest";
import { adjacentRequestId, isTextEntry, resolveShortcut } from "./keyboard-shortcuts.ts";

const key = (k: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe("resolveShortcut", () => {
  it.each([
    ["j", "next-request"],
    ["k", "previous-request"],
    ["Escape", "clear-selection"],
    ["/", "focus-search"],
    ["t", "toggle-theme"],
    ["p", "toggle-pause"],
    ["?", "toggle-help"],
  ])("maps %s to %s", (pressed, action) => {
    expect(resolveShortcut(key(pressed), { tagName: "BODY" })).toBe(action);
  });

  it("ignores keys that mean nothing", () => {
    expect(resolveShortcut(key("x"))).toBeUndefined();
  });

  it.each(["ctrlKey", "metaKey", "altKey"] as const)("never claims a %s chord", (modifier) => {
    expect(resolveShortcut(key("t", { [modifier]: true }))).toBeUndefined();
  });

  it.each(["INPUT", "TEXTAREA", "SELECT"])("does not steal typing in a %s", (tagName) => {
    expect(resolveShortcut(key("j"), { tagName })).toBeUndefined();
  });

  it("does not steal typing in a contenteditable element", () => {
    expect(resolveShortcut(key("j"), { tagName: "DIV", isContentEditable: true })).toBeUndefined();
  });

  it("still lets Escape through from a text field", () => {
    expect(resolveShortcut(key("Escape"), { tagName: "INPUT" })).toBe("clear-selection");
  });
});

describe("isTextEntry", () => {
  it("is false for no target", () => {
    expect(isTextEntry(null)).toBe(false);
  });
});

describe("adjacentRequestId", () => {
  const requests = ["a", "b", "c"].map((id) => ({ id }) as RequestModel);

  it("moves one step through the list", () => {
    expect(adjacentRequestId(requests, "a", "next")).toBe("b");
    expect(adjacentRequestId(requests, "c", "previous")).toBe("b");
  });

  it("stays put at either end instead of wrapping", () => {
    expect(adjacentRequestId(requests, "c", "next")).toBe("c");
    expect(adjacentRequestId(requests, "a", "previous")).toBe("a");
  });

  it("starts from the first row going next and the last going previous", () => {
    expect(adjacentRequestId(requests, undefined, "next")).toBe("a");
    expect(adjacentRequestId(requests, undefined, "previous")).toBe("c");
  });

  it("treats a selection that left the list as no selection", () => {
    expect(adjacentRequestId(requests, "gone", "next")).toBe("a");
  });

  it("returns nothing for an empty list", () => {
    expect(adjacentRequestId([], undefined, "next")).toBeUndefined();
  });
});
