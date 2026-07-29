import type { AddressInfo } from "node:net";
import type { CapturedEvent } from "@wevna/protocol";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wevnaFastifyEnrichment } from "./fastify-enrichment.js";
import { HttpInstrumentation } from "./http-instrumentation.js";

// Exercises the real integration path — a live server, HttpInstrumentation
// patching http.Server.prototype.emit, and the Fastify plugin enriching
// via the shared (module-private) symbol — rather than reaching into that
// symbol directly, which a fastify.inject()-based test couldn't observe
// anyway: inject() bypasses the raw http.Server entirely.
describe("wevnaFastifyEnrichment", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  let instrumentation: HttpInstrumentation | undefined;

  afterEach(async () => {
    instrumentation?.stop();
    instrumentation = undefined;
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function listen(app: ReturnType<typeof Fastify>): Promise<number> {
    apps.push(app);
    await app.listen({ port: 0 });
    return (app.server.address() as AddressInfo).port;
  }

  it("enriches the published event with framework, route, and handler", async () => {
    const app = Fastify();
    await app.register(wevnaFastifyEnrichment);
    app.get("/widgets/:id", async function getWidget() {
      return { ok: true };
    });
    const port = await listen(app);

    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);
    instrumentation.start();

    await fetch(`http://localhost:${port}/widgets/42`);

    expect(publish.mock.calls[0]?.[0].attributes).toMatchObject({
      framework: "fastify",
      route: "/widgets/:id",
      handler: "getWidget",
    });
  });

  it("still publishes the base event, without enrichment, for an unmatched route", async () => {
    const app = Fastify();
    await app.register(wevnaFastifyEnrichment);
    const port = await listen(app);

    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);
    instrumentation.start();

    await fetch(`http://localhost:${port}/does-not-exist`);

    const attributes = publish.mock.calls[0]?.[0].attributes;
    expect(attributes?.statusCode).toBe(404);
    expect(attributes?.framework).toBeUndefined();
    expect(attributes?.route).toBeUndefined();
  });

  it("does not publish a duplicate event for an enriched request", async () => {
    const app = Fastify();
    await app.register(wevnaFastifyEnrichment);
    app.get("/widgets/:id", async () => ({ ok: true }));
    const port = await listen(app);

    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);
    instrumentation.start();

    await fetch(`http://localhost:${port}/widgets/42`);

    expect(publish).toHaveBeenCalledOnce();
  });
});
