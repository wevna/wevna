import { describe, expect, it } from "vitest";
import { createSession, stopSession } from "./session.js";

describe("createSession", () => {
  it("creates a running session with a unique id and start time", () => {
    const session = createSession();

    expect(session.status).toBe("running");
    expect(typeof session.id).toBe("string");
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.startedAt).toBeTypeOf("number");
  });

  it("generates a different id for each session", () => {
    const a = createSession();
    const b = createSession();

    expect(a.id).not.toBe(b.id);
  });
});

describe("stopSession", () => {
  it("marks the session as stopped without changing its id or start time", () => {
    const session = createSession();

    const stopped = stopSession(session);

    expect(stopped.status).toBe("stopped");
    expect(stopped.id).toBe(session.id);
    expect(stopped.startedAt).toBe(session.startedAt);
  });

  it("does not mutate the original session", () => {
    const session = createSession();

    stopSession(session);

    expect(session.status).toBe("running");
  });
});
