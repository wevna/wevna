import { afterEach, describe, expect, it } from "vitest";
import { wevna } from "./index.js";

describe("wevna", () => {
  afterEach(async () => {
    await wevna.stop();
  });

  it("starts and stops the local server", async () => {
    await wevna.start({ port: 0 });
    await wevna.stop();
  });

  it("does not start a second server when already running", async () => {
    await wevna.start({ port: 0 });

    await expect(wevna.start({ port: 0 })).resolves.toBeUndefined();
  });

  it("coalesces concurrent start calls into a single server", async () => {
    await expect(
      Promise.all([wevna.start({ port: 0 }), wevna.start({ port: 0 })]),
    ).resolves.toEqual([undefined, undefined]);
  });

  it("does not throw when stopping a server that is not running", async () => {
    await expect(wevna.stop()).resolves.toBeUndefined();
  });
});
