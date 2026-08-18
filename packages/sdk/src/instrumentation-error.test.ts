import { describe, expect, it } from "vitest";
import { describeInstrumentationError } from "./instrumentation-error.js";

describe("describeInstrumentationError", () => {
  it("uses a driver error's code instead of its message", () => {
    const error = new Error('invalid input syntax for type integer: "abc"') as Error & {
      code: string;
    };
    error.code = "22P02";

    expect(describeInstrumentationError(error)).toEqual({ error: "22P02" });
  });

  it("uses a system error's code the same way", () => {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:5432") as Error & { code: string };
    error.code = "ECONNREFUSED";

    expect(describeInstrumentationError(error)).toEqual({ error: "ECONNREFUSED" });
  });

  it("falls back to the message when there is no code", () => {
    expect(describeInstrumentationError(new Error("boom"))).toEqual({ error: "boom" });
  });

  it("falls back to the message for a non-string code", () => {
    const error = new Error("boom") as Error & { code: number };
    error.code = 42;

    expect(describeInstrumentationError(error)).toEqual({ error: "boom" });
  });

  it("stringifies a thrown non-Error value", () => {
    expect(describeInstrumentationError("just a string")).toEqual({ error: "just a string" });
  });

  it("never leaks a value present only in a code-bearing error's message", () => {
    const error = new Error('duplicate key value violates unique constraint "users_email_key"');
    (error as Error & { code: string }).code = "23505";

    const attributes = JSON.stringify(describeInstrumentationError(error));

    expect(attributes).not.toContain("users_email_key");
    expect(attributes).toContain("23505");
  });
});
