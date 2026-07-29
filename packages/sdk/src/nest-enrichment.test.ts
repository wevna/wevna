import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CapturedEvent } from "@wevna/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpInstrumentation } from "./http-instrumentation.js";
import type { NestCallHandlerLike, NestExecutionContextLike } from "./nest-enrichment.js";
import { WevnaNestInterceptor } from "./nest-enrichment.js";

function makeContext(request: unknown, className = "WidgetsController", handlerName = "getWidget") {
  const context: NestExecutionContextLike = {
    switchToHttp: () => ({ getRequest: () => request }),
    getClass: () => ({ name: className }),
    getHandler: () => ({ name: handlerName }),
  };
  return context;
}

function makeNext(returnValue: unknown = "handled"): NestCallHandlerLike {
  return { handle: () => returnValue };
}

describe("WevnaNestInterceptor", () => {
  it("calls through to next.handle() and returns its result", () => {
    const interceptor = new WevnaNestInterceptor();
    const next = makeNext("result");

    const result = interceptor.intercept(makeContext({}), next);

    expect(result).toBe("result");
  });

  it("does not throw when the request shape is unexpected", () => {
    const interceptor = new WevnaNestInterceptor();

    expect(() => interceptor.intercept(makeContext(null), makeNext())).not.toThrow();
    expect(() => interceptor.intercept(makeContext(undefined), makeNext())).not.toThrow();
    expect(() => interceptor.intercept(makeContext(42), makeNext())).not.toThrow();
  });

  it("does not throw when context methods themselves throw", () => {
    const interceptor = new WevnaNestInterceptor();
    const context: NestExecutionContextLike = {
      switchToHttp: () => {
        throw new Error("boom");
      },
      getClass: () => ({ name: "X" }),
      getHandler: () => ({ name: "y" }),
    };

    expect(() => interceptor.intercept(context, makeNext())).not.toThrow();
  });
});

describe("WevnaNestInterceptor integration with HttpInstrumentation", () => {
  const servers: http.Server[] = [];
  let instrumentation: HttpInstrumentation | undefined;

  afterEach(async () => {
    instrumentation?.stop();
    instrumentation = undefined;
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  it("enriches the published event for a Nest-on-Express-style request", async () => {
    const interceptor = new WevnaNestInterceptor();

    const server = http.createServer((req, res) => {
      // Nest-on-Express: the interceptor runs ahead of the handler, with
      // direct access to the same raw req/res Express itself would use.
      interceptor.intercept(makeContext(req, "WidgetsController", "getWidget"), makeNext());
      res.end("ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);
    instrumentation.start();

    await fetch(`http://localhost:${port}/widgets/42`);

    expect(publish.mock.calls[0]?.[0].attributes).toMatchObject({
      framework: "nestjs",
      handler: "WidgetsController.getWidget",
    });
  });

  it("enriches the published event for a Nest-on-Fastify-style request (raw wrapper)", async () => {
    const interceptor = new WevnaNestInterceptor();

    const server = http.createServer((req, res) => {
      // Nest-on-Fastify: getRequest() returns a FastifyRequest, whose raw
      // Node request lives at `.raw`.
      interceptor.intercept(
        makeContext({ raw: req }, "WidgetsController", "getWidget"),
        makeNext(),
      );
      res.end("ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new HttpInstrumentation(publish);
    instrumentation.start();

    await fetch(`http://localhost:${port}/widgets/42`);

    expect(publish.mock.calls[0]?.[0].attributes).toMatchObject({
      framework: "nestjs",
      handler: "WidgetsController.getWidget",
    });
  });
});
