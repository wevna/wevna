import { performance } from "node:perf_hooks";
import { describeInstrumentationError } from "./instrumentation-error.js";
import type { PluginEvent } from "./plugin.js";

// Emits PluginEvent, not CapturedEvent — see pg-instrumentation.ts for why.
export type PublishPluginEvent = (event: PluginEvent) => void;

// Structural, not ioredis's Command class: only the two fields this needs
// to read. Every ioredis convenience method (get, set, expire, ...)
// ultimately constructs one of these and calls sendCommand() with it, so
// wrapping sendCommand is a single choke point that covers all of them.
export interface RedisCommandLike {
  name?: unknown;
  promise?: Promise<unknown>;
}

export interface RedisSendCommandLike {
  sendCommand: (command: RedisCommandLike, ...rest: unknown[]) => unknown;
}

// Wevna's ioredis producer. Wraps sendCommand() so every command still
// behaves exactly as before, but also publishes a redis.command event once
// it settles (attached to the Command's own .promise, which resolves
// independently of whatever sendCommand itself returns — so this never
// depends on sendCommand's return value, just observes it).
//
// Deliberately never records command arguments or results — only the
// command *name* (e.g. "get", "set"), timing, and — when the command
// rejects — a description of the failure (see instrumentation-error.ts).
// Redis commands routinely carry the values themselves as plain arguments
// (SET password s3cr3t), unlike parameterized SQL, so there's no safe
// subset of args to keep; the full payload is never captured, per spec.
export class RedisInstrumentation {
  readonly #publish: PublishPluginEvent;
  #wrapped = new WeakSet<RedisSendCommandLike>();

  constructor(publish: PublishPluginEvent) {
    this.#publish = publish;
  }

  instrument(client: RedisSendCommandLike): void {
    if (this.#wrapped.has(client)) {
      return;
    }
    this.#wrapped.add(client);

    const originalSendCommand = client.sendCommand.bind(client);
    const publish = this.#publish;

    client.sendCommand = (command: RedisCommandLike, ...rest: unknown[]): unknown => {
      const startedAt = performance.now();
      const commandName = typeof command?.name === "string" ? command.name : "";

      if (command?.promise && typeof command.promise.then === "function") {
        const report = (error?: unknown): void => {
          publish({
            kind: "redis.command",
            attributes: {
              command: commandName,
              durationMs: performance.now() - startedAt,
              ...(error !== undefined ? describeInstrumentationError(error) : {}),
            },
          });
        };
        command.promise.then(
          () => report(),
          (error: unknown) => report(error),
        );
      }

      return originalSendCommand(command, ...rest);
    };
  }
}
