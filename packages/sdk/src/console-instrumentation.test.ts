import type { CapturedEvent } from "@wevna/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleInstrumentation } from "./console-instrumentation.js";

describe("ConsoleInstrumentation", () => {
  const originalConsoleLog = console.log;

  afterEach(() => {
    console.log = originalConsoleLog;
  });

  it("still prints via the original console.log", () => {
    const mockLog = vi.fn();
    console.log = mockLog;
    const instrumentation = new ConsoleInstrumentation(() => {});

    instrumentation.start();
    console.log("hello", 42);

    expect(mockLog).toHaveBeenCalledExactlyOnceWith("hello", 42);
  });

  it("publishes a CapturedEvent for every console.log call", () => {
    console.log = vi.fn();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ConsoleInstrumentation(publish);

    instrumentation.start();
    console.log("hello");
    console.log("world");

    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("publishes an event with kind 'console.log'", () => {
    console.log = vi.fn();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ConsoleInstrumentation(publish);

    instrumentation.start();
    console.log("hello");

    expect(publish.mock.calls[0]?.[0].kind).toBe("console.log");
  });

  it("includes the original arguments in attributes", () => {
    console.log = vi.fn();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ConsoleInstrumentation(publish);

    instrumentation.start();
    console.log("hello", 42, { a: 1 });

    expect(publish.mock.calls[0]?.[0].attributes.arguments).toEqual(["hello", 42, { a: 1 }]);
    expect(publish.mock.calls[0]?.[0].attributes.message).toBe("hello 42 { a: 1 }");
  });

  it("restores the original console.log on stop", () => {
    const mockLog = vi.fn();
    console.log = mockLog;
    const instrumentation = new ConsoleInstrumentation(() => {});

    instrumentation.start();
    instrumentation.stop();

    expect(console.log).toBe(mockLog);
  });

  it("no longer publishes once stopped", () => {
    console.log = vi.fn();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ConsoleInstrumentation(publish);

    instrumentation.start();
    instrumentation.stop();
    console.log("hello");

    expect(publish).not.toHaveBeenCalled();
  });

  it("does not double-wrap console.log when started twice", () => {
    console.log = vi.fn();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ConsoleInstrumentation(publish);

    instrumentation.start();
    const wrapped = console.log;
    instrumentation.start();

    expect(console.log).toBe(wrapped);

    console.log("hello");
    expect(publish).toHaveBeenCalledOnce();
  });

  it("is safe to stop multiple times", () => {
    const mockLog = vi.fn();
    console.log = mockLog;
    const instrumentation = new ConsoleInstrumentation(() => {});

    instrumentation.start();
    instrumentation.stop();

    expect(() => instrumentation.stop()).not.toThrow();
    expect(console.log).toBe(mockLog);
  });
});
