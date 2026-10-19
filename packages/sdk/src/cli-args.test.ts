import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli-args.js";

describe("parseArgs", () => {
  it("returns no options for no arguments", () => {
    expect(parseArgs([])).toEqual({});
  });

  it("reads --port and --host", () => {
    expect(parseArgs(["--port", "5000", "--host", "0.0.0.0"])).toEqual({
      port: 5000,
      host: "0.0.0.0",
    });
  });

  it("allows port 0 so the OS can pick one", () => {
    expect(parseArgs(["--port", "0"])).toEqual({ port: 0 });
  });

  it("asks for help", () => {
    expect(parseArgs(["--help"])).toBe("help");
  });

  it.each([
    [["--port", "abc"], /--port must be/],
    [["--port", "70000"], /--port must be/],
    [["--port"], /needs a value/],
    [["--nope"], /unknown argument/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});
