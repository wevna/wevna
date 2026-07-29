import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { detectExpressEnrichment } from "./express-enrichment.js";

describe("detectExpressEnrichment", () => {
  it("returns undefined for a plain request with no route", () => {
    const req = { method: "GET", url: "/" } as unknown as http.IncomingMessage;

    expect(detectExpressEnrichment(req)).toBeUndefined();
  });

  it("returns undefined when route.path isn't a string", () => {
    const req = { route: { path: 42 } } as unknown as http.IncomingMessage;

    expect(detectExpressEnrichment(req)).toBeUndefined();
  });

  it("reads the matched route path and last handler name off req.route", () => {
    const req = {
      route: { path: "/widgets/:id", stack: [{ name: "getWidget" }] },
    } as unknown as http.IncomingMessage;

    expect(detectExpressEnrichment(req)).toEqual({
      framework: "express",
      route: "/widgets/:id",
      handler: "getWidget",
    });
  });

  it("omits handler when the layer name is anonymous or missing", () => {
    const req = {
      route: { path: "/widgets", stack: [{ name: "<anonymous>" }] },
    } as unknown as http.IncomingMessage;

    expect(detectExpressEnrichment(req)).toEqual({ framework: "express", route: "/widgets" });
  });
});

describe("detectExpressEnrichment against a real Express app", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  it("finds the matched route on the raw request once the response finishes", async () => {
    const app = express();
    app.get("/widgets/:id", function getWidget(_req, res) {
      res.json({ ok: true });
    });

    const server = http.createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const enrichmentPromise = new Promise((resolve) => {
      server.on("request", (req, res) => {
        res.once("finish", () => resolve(detectExpressEnrichment(req)));
      });
    });
    await fetch(`http://localhost:${port}/widgets/42`);

    expect(await enrichmentPromise).toEqual({
      framework: "express",
      route: "/widgets/:id",
      handler: "getWidget",
    });
  });
});
