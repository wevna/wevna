import type { CapturedEvent } from "@wevna/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureException, ExceptionInstrumentation } from "./exception-instrumentation.js";

describe("ExceptionInstrumentation#capture", () => {
  it("publishes an event with kind 'exception.captured'", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ExceptionInstrumentation(publish);

    instrumentation.capture(new Error("boom"));

    expect(publish.mock.calls[0]?.[0].kind).toBe("exception.captured");
  });

  it("captures the error's name, message, and stack", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ExceptionInstrumentation(publish);
    const error = new TypeError("cannot read property of undefined");

    instrumentation.capture(error);

    const attributes = publish.mock.calls[0]?.[0].attributes;
    expect(attributes?.name).toBe("TypeError");
    expect(attributes?.message).toBe("cannot read property of undefined");
    expect(attributes?.stack).toBe(error.stack);
  });

  it("preserves the stack trace exactly as captured, with no processing", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ExceptionInstrumentation(publish);
    const error = new Error("boom");

    instrumentation.capture(error);

    expect(publish.mock.calls[0]?.[0].attributes.stack).toBe(error.stack);
  });

  it("still captures a non-Error thrown value, without a stack", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ExceptionInstrumentation(publish);

    instrumentation.capture("a plain string was thrown");

    const attributes = publish.mock.calls[0]?.[0].attributes;
    expect(attributes?.name).toBe("NonErrorThrown");
    expect(attributes?.message).toBe("a plain string was thrown");
    expect("stack" in (attributes ?? {})).toBe(false);
  });

  it("merges extra attributes onto the event", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ExceptionInstrumentation(publish);

    instrumentation.capture(new Error("boom"), { framework: "fastify" });

    expect(publish.mock.calls[0]?.[0].attributes.framework).toBe("fastify");
  });

  it("assigns each captured exception a unique id", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ExceptionInstrumentation(publish);

    instrumentation.capture(new Error("first"));
    instrumentation.capture(new Error("second"));

    expect(publish.mock.calls[0]?.[0].id).not.toBe(publish.mock.calls[1]?.[0].id);
  });

  it("does not publish the same Error object twice, even captured from two different call sites", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ExceptionInstrumentation(publish);
    const error = new Error("seen twice");

    // Mirrors HttpInstrumentation's dispatch catch capturing an error
    // before it's rethrown and eventually also reaches uncaughtException.
    instrumentation.capture(error, { origin: "requestDispatch" });
    instrumentation.capture(error, { origin: "uncaughtException" });

    expect(publish).toHaveBeenCalledOnce();
  });

  it("still publishes two distinct non-Error throws with the same message (not reference-comparable)", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ExceptionInstrumentation(publish);

    instrumentation.capture("boom");
    instrumentation.capture("boom");

    expect(publish).toHaveBeenCalledTimes(2);
  });
});

describe("ExceptionInstrumentation process-level capture", () => {
  let instrumentation: ExceptionInstrumentation | undefined;

  afterEach(() => {
    instrumentation?.stop();
    instrumentation = undefined;
  });

  it("captures a synthetic uncaughtException", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new ExceptionInstrumentation(publish);
    instrumentation.start();

    process.emit("uncaughtException", new Error("uncaught boom"));

    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0].attributes.message).toBe("uncaught boom");
    expect(publish.mock.calls[0]?.[0].attributes.origin).toBe("uncaughtException");
  });

  it("captures a synthetic unhandledRejection", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new ExceptionInstrumentation(publish);
    instrumentation.start();

    process.emit("unhandledRejection", new Error("rejected boom"), Promise.resolve());

    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0].attributes.message).toBe("rejected boom");
    expect(publish.mock.calls[0]?.[0].attributes.origin).toBe("unhandledRejection");
  });

  it("does not capture once stopped", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new ExceptionInstrumentation(publish);
    instrumentation.start();
    instrumentation.stop();
    // A safety listener so this emit isn't *genuinely* unhandled (which
    // Vitest's own runner would separately flag) — the assertion below is
    // only about our own instrumentation no longer capturing it.
    const safetyListener = vi.fn();
    process.on("uncaughtException", safetyListener);

    process.emit("uncaughtException", new Error("after stop"));

    process.off("uncaughtException", safetyListener);
    expect(publish).not.toHaveBeenCalled();
  });

  it("is idempotent: starting twice does not double-register listeners", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new ExceptionInstrumentation(publish);
    instrumentation.start();
    instrumentation.start();

    process.emit("uncaughtException", new Error("only once"));

    expect(publish).toHaveBeenCalledOnce();
  });

  it("is safe to stop when never started", () => {
    instrumentation = new ExceptionInstrumentation(vi.fn());

    expect(() => instrumentation?.stop()).not.toThrow();
  });

  it("removes exactly its own listeners on stop, leaving others untouched", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new ExceptionInstrumentation(publish);
    const appOwnListener = vi.fn();
    process.on("uncaughtException", appOwnListener);

    instrumentation.start();
    instrumentation.stop();
    process.emit("uncaughtException", new Error("app still handles this"));

    process.off("uncaughtException", appOwnListener);
    expect(publish).not.toHaveBeenCalled();
    expect(appOwnListener).toHaveBeenCalledOnce();
  });
});

describe("captureException (module-level)", () => {
  let instrumentation: ExceptionInstrumentation | undefined;

  afterEach(() => {
    instrumentation?.stop();
    instrumentation = undefined;
  });

  it("does not throw and does not publish when no instrumentation has started", () => {
    expect(() => captureException(new Error("no runtime yet"))).not.toThrow();
  });

  it("delegates to the currently-started instrumentation", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new ExceptionInstrumentation(publish);
    instrumentation.start();

    captureException(new Error("from framework glue"), { framework: "fastify" });

    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0].attributes.framework).toBe("fastify");
  });

  it("no-ops again once instrumentation has stopped", () => {
    const publish = vi.fn<(event: CapturedEvent) => void>();
    instrumentation = new ExceptionInstrumentation(publish);
    instrumentation.start();
    instrumentation.stop();

    expect(() => captureException(new Error("after stop"))).not.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });
});
