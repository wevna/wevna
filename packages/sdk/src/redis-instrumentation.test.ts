import { Command } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "./plugin.js";
import type { RedisCommandLike, RedisSendCommandLike } from "./redis-instrumentation.js";
import { RedisInstrumentation } from "./redis-instrumentation.js";

function makeClient(implementation: (command: RedisCommandLike) => unknown): RedisSendCommandLike {
  return { sendCommand: implementation };
}

function makeCommand(name: string): {
  command: RedisCommandLike;
  resolve: (v?: unknown) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v?: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { command: { name, promise }, resolve, reject };
}

describe("RedisInstrumentation", () => {
  it("publishes a redis.command event with the command name and duration once it settles", async () => {
    const { command, resolve } = makeCommand("get");
    const client = makeClient(() => undefined);
    const publish = vi.fn<(event: PluginEvent) => void>();
    new RedisInstrumentation(publish).instrument(client);

    client.sendCommand(command);
    resolve("some-value");
    await command.promise;
    await Promise.resolve();

    expect(publish).toHaveBeenCalledOnce();
    const event = publish.mock.calls[0]?.[0];
    expect(event?.kind).toBe("redis.command");
    expect(event?.attributes.command).toBe("get");
    expect(event?.attributes.durationMs).toBeTypeOf("number");
  });

  it("never records the command's arguments or resolved value", async () => {
    const { command, resolve } = makeCommand("set");
    (command as { args?: unknown }).args = ["password", "s3cr3t-value"];
    const client = makeClient(() => undefined);
    const publish = vi.fn<(event: PluginEvent) => void>();
    new RedisInstrumentation(publish).instrument(client);

    client.sendCommand(command);
    resolve("OK");
    await command.promise;
    await Promise.resolve();

    const attributes = JSON.stringify(publish.mock.calls[0]?.[0].attributes);
    expect(attributes).not.toContain("s3cr3t-value");
    expect(attributes).not.toContain("OK");
  });

  it("still publishes an event when the command rejects", async () => {
    const { command, reject } = makeCommand("get");
    const client = makeClient(() => undefined);
    const publish = vi.fn<(event: PluginEvent) => void>();
    new RedisInstrumentation(publish).instrument(client);

    client.sendCommand(command);
    reject(new Error("connection closed"));
    await command.promise?.catch(() => {});
    await Promise.resolve();

    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0].attributes.command).toBe("get");
  });

  it("reports a rejected command's error, distinguishing it from a success", async () => {
    const { command, reject } = makeCommand("get");
    const client = makeClient(() => undefined);
    const publish = vi.fn<(event: PluginEvent) => void>();
    new RedisInstrumentation(publish).instrument(client);

    client.sendCommand(command);
    reject(new Error("WRONGTYPE Operation against a key holding the wrong kind of value"));
    await command.promise?.catch(() => {});
    await Promise.resolve();

    expect(publish.mock.calls[0]?.[0].attributes.error).toBe(
      "WRONGTYPE Operation against a key holding the wrong kind of value",
    );
  });

  it("does not include an error attribute for a successful command", async () => {
    const { command, resolve } = makeCommand("get");
    const client = makeClient(() => undefined);
    const publish = vi.fn<(event: PluginEvent) => void>();
    new RedisInstrumentation(publish).instrument(client);

    client.sendCommand(command);
    resolve("value");
    await command.promise;
    await Promise.resolve();

    expect(publish.mock.calls[0]?.[0].attributes.error).toBeUndefined();
  });

  it("calls through to the original sendCommand and preserves its return value", () => {
    const { command } = makeCommand("get");
    const client = makeClient(() => "original-return-value");
    new RedisInstrumentation(vi.fn()).instrument(client);

    expect(client.sendCommand(command)).toBe("original-return-value");
  });

  it("does not double-wrap the same client when instrumented twice", async () => {
    let callCount = 0;
    const client = makeClient(() => {
      callCount += 1;
      return undefined;
    });
    const publish = vi.fn<(event: PluginEvent) => void>();
    const instrumentation = new RedisInstrumentation(publish);
    instrumentation.instrument(client);
    instrumentation.instrument(client);

    const { command, resolve } = makeCommand("ping");
    client.sendCommand(command);
    resolve();
    await command.promise;
    await Promise.resolve();

    expect(callCount).toBe(1);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("does not throw and does not publish for a command with no promise", () => {
    const client = makeClient(() => undefined);
    const publish = vi.fn<(event: PluginEvent) => void>();
    new RedisInstrumentation(publish).instrument(client);

    expect(() => client.sendCommand({ name: "subscribe" })).not.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });

  it("accepts a real ioredis Command instance (structural compatibility)", () => {
    const client = makeClient(() => undefined);
    new RedisInstrumentation(vi.fn()).instrument(client);
    const realCommand = new Command("get", ["foo"]);

    expect(() => client.sendCommand(realCommand)).not.toThrow();

    // Never actually sent anywhere, so settle it to avoid an unhandled
    // rejection warning from the never-awaited promise.
    realCommand.reject(new Error("not sent in this test"));
    realCommand.promise.catch(() => {});
  });
});
