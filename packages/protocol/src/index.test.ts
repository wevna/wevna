import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, RECORDING_FORMAT_VERSION } from "./index.js";

describe("frozen contract versions", () => {
  // PROTOCOL_VERSION and RECORDING_FORMAT_VERSION are both frozen at 1 for
  // the entire 1.x line (STABILITY.md). Nothing else enforces that — an
  // accidental bump here would pass every other test in the repo, since
  // every other package just reads these constants rather than checking
  // their value, and would mislabel every recording written afterward.
  it("keeps PROTOCOL_VERSION frozen at 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("keeps RECORDING_FORMAT_VERSION frozen at 1", () => {
    expect(RECORDING_FORMAT_VERSION).toBe(1);
  });
});
