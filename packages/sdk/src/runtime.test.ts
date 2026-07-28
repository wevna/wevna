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
});
