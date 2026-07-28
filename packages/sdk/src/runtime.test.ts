import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "./runtime.js";

describe("Runtime", () => {
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.stop();
  });

  it("starts stopped", () => {
    runtime = new Runtime();

    expect(runtime.state).toBe("stopped");
    expect(runtime.isRunning).toBe(false);
  });

  it("transitions to running after start and back to stopped after stop", async () => {
    runtime = new Runtime();

    await runtime.start({ port: 0 });
    expect(runtime.state).toBe("running");
    expect(runtime.isRunning).toBe(true);

    await runtime.stop();
    expect(runtime.state).toBe("stopped");
    expect(runtime.isRunning).toBe(false);
  });

  it("does not start a second server when already running", async () => {
    runtime = new Runtime();

    await runtime.start({ port: 0 });
    await expect(runtime.start({ port: 0 })).resolves.toBeUndefined();
    expect(runtime.state).toBe("running");
  });

  it("coalesces concurrent start calls into a single server", async () => {
    runtime = new Runtime();

    await expect(
      Promise.all([runtime.start({ port: 0 }), runtime.start({ port: 0 })]),
    ).resolves.toEqual([undefined, undefined]);
    expect(runtime.state).toBe("running");
  });

  it("does not throw when stopping a runtime that is not running", async () => {
    runtime = new Runtime();

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(runtime.state).toBe("stopped");
  });

  it("resets to stopped when the server fails to start, allowing a retry", async () => {
    runtime = new Runtime();

    await expect(runtime.start({ port: -1 })).rejects.toThrow();
    expect(runtime.state).toBe("stopped");

    await expect(runtime.start({ port: 0 })).resolves.toBeUndefined();
    expect(runtime.state).toBe("running");
  });

  it("has no session before the first start", () => {
    runtime = new Runtime();

    expect(runtime.session).toBeUndefined();
  });

  it("creates a running session when started", async () => {
    runtime = new Runtime();

    await runtime.start({ port: 0 });

    expect(runtime.session).toBeDefined();
    expect(runtime.session?.status).toBe("running");
  });

  it("marks the session stopped when stopped", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const sessionId = runtime.session?.id;

    await runtime.stop();

    expect(runtime.session?.id).toBe(sessionId);
    expect(runtime.session?.status).toBe("stopped");
  });

  it("keeps the same session across a repeated start", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    const sessionId = runtime.session?.id;

    await runtime.start({ port: 0 });

    expect(runtime.session?.id).toBe(sessionId);
    expect(runtime.session?.status).toBe("running");
  });

  it("keeps the session stopped across a repeated stop", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0 });
    await runtime.stop();
    const sessionId = runtime.session?.id;

    await runtime.stop();

    expect(runtime.session?.id).toBe(sessionId);
    expect(runtime.session?.status).toBe("stopped");
  });

  it("discards the session if the server fails to start", async () => {
    runtime = new Runtime();

    await expect(runtime.start({ port: -1 })).rejects.toThrow();

    expect(runtime.session).toBeUndefined();
  });

  it("creates a fresh session on a successful start after a failed one", async () => {
    runtime = new Runtime();
    await expect(runtime.start({ port: -1 })).rejects.toThrow();

    await runtime.start({ port: 0 });

    expect(runtime.session?.status).toBe("running");
  });
});
