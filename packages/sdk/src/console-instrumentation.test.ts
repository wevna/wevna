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

  it("formats the arguments into a message", () => {
    console.log = vi.fn();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ConsoleInstrumentation(publish);

    instrumentation.start();
    console.log("hello", 42, { a: 1 });

    expect(publish.mock.calls[0]?.[0].attributes.message).toBe("hello 42 { a: 1 }");
  });

  // The raw values are user-controlled and are serialized downstream, so
  // capturing them is what made console.log(req) throw a circular-structure
  // TypeError back into the caller. Nothing ever read them.
  it("never captures the raw argument values", () => {
    console.log = vi.fn();
    const publish = vi.fn<(event: CapturedEvent) => void>();
    const instrumentation = new ConsoleInstrumentation(publish);

    instrumentation.start();
    console.log("hello", 42, { a: 1 });

    expect(publish.mock.calls[0]?.[0].attributes).not.toHaveProperty("arguments");
  });

  it("does not throw when an argument cannot be serialized", () => {
    console.log = vi.fn();
    const circular: Record<string, unknown> = { name: "req" };
    circular.self = circular;
    const published: CapturedEvent[] = [];
    const instrumentation = new ConsoleInstrumentation((event) => {
      // Stands in for the WebSocket transport, the real subscriber whose
      // JSON.stringify threw on the way back out to the caller.
      JSON.stringify(event);
      published.push(event);
    });

    instrumentation.start();

    expect(() => {
      console.log(circular);
    }).not.toThrow();
    expect(published).toHaveLength(1);
  });

  it("does not throw on a BigInt argument", () => {
    console.log = vi.fn();
    const instrumentation = new ConsoleInstrumentation((event) => {
      JSON.stringify(event);
    });

    instrumentation.start();

    expect(() => {
      console.log(10n);
    }).not.toThrow();
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
