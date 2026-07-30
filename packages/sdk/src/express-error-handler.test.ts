import type http from "node:http";
import type { AddressInfo } from "node:net";
import type { CapturedEvent } from "@wevna/protocol";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { ExceptionInstrumentation } from "./exception-instrumentation.js";
import { type ExpressNextFunction, wevnaExpressErrorHandler } from "./express-error-handler.js";

describe("wevnaExpressErrorHandler", () => {
  let server: http.Server | undefined;
  let instrumentation: ExceptionInstrumentation | undefined;

  afterEach(async () => {
    instrumentation?.stop();
    instrumentation = undefined;
    if (server) {
      await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    }
  });

  it("captures a synchronously-thrown handler error without changing the response", async () => {
    const captured: CapturedEvent[] = [];
    instrumentation = new ExceptionInstrumentation((event) => captured.push(event));
    instrumentation.start();

    const app = express();
    app.get("/boom", () => {
      throw new Error("sync boom");
    });
    app.use(wevnaExpressErrorHandler);
    server = app.listen(0);
    await new Promise((resolve) => server?.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://localhost:${port}/boom`);

    expect(response.status).toBe(500);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe("exception.captured");
    expect(captured[0]?.attributes.message).toBe("sync boom");
    expect(captured[0]?.attributes.framework).toBe("express");
  });

  it("captures an asynchronously-rejected handler error without changing the response", async () => {
    const captured: CapturedEvent[] = [];
    instrumentation = new ExceptionInstrumentation((event) => captured.push(event));
    instrumentation.start();

    const app = express();
    app.get("/async-boom", async () => {
      await Promise.resolve();
      throw new Error("async boom");
    });
    app.use(wevnaExpressErrorHandler);
    server = app.listen(0);
    await new Promise((resolve) => server?.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://localhost:${port}/async-boom`);

    expect(response.status).toBe(500);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.attributes.message).toBe("async boom");
  });

  it("still passes the error to the next error handler in the chain", () => {
    const error = new Error("boom");
    const next: ExpressNextFunction = (err) => {
      expect(err).toBe(error);
    };

    wevnaExpressErrorHandler(error, {} as never, {} as never, next);
  });
});
