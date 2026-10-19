import { afterEach, describe, expect, it } from "vitest";
import { type StartedServer, startServer } from "./start.js";

describe("startServer", () => {
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.stop();
    started = undefined;
  });

  it("starts and reports the bound host, port, and url", async () => {
    started = await startServer({ port: 0 });

    expect(started.host).toBe("localhost");
    expect(started.port).toBeGreaterThan(0);
    expect(started.url).toBe(`http://localhost:${started.port}`);
  });

  it("prints a browsable url when bound to all interfaces", async () => {
    started = await startServer({ port: 0, host: "0.0.0.0" });

    expect(started.host).toBe("0.0.0.0");
    expect(started.url).toBe(`http://localhost:${started.port}`);
  });

  it("throws a meaningful error when the port is already in use", async () => {
    started = await startServer({ port: 0 });

    await expect(startServer({ port: started.port })).rejects.toThrow(/already in use/i);
  });
});
