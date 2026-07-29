import { randomUUID } from "node:crypto";
import { format } from "node:util";
import type { CapturedEvent } from "@wevna/protocol";

export type PublishCapturedEvent = (event: CapturedEvent) => void;

// Wevna's first producer: wraps console.log so every call also publishes a
// CapturedEvent, without changing what gets printed. This only ever emits
// the raw event — Runtime remains solely responsible for turning it into an
// Envelope and handing it to the Event Bus.
export class ConsoleInstrumentation {
  readonly #publish: PublishCapturedEvent;
  #originalLog: typeof console.log | undefined;

  constructor(publish: PublishCapturedEvent) {
    this.#publish = publish;
  }

  start(): void {
    if (this.#originalLog) {
      return;
    }

    // Not bound: Node's global console methods are already bound to the
    // console instance, and storing the exact reference (rather than a new
    // bound wrapper) is what lets stop() restore console.log to precisely
    // what it was before.
    const originalLog = console.log;
    this.#originalLog = originalLog;

    console.log = (...args: unknown[]): void => {
      originalLog(...args);

      this.#publish({
        id: randomUUID(),
        kind: "console.log",
        occurredAt: Date.now(),
        attributes: {
          arguments: args,
          message: format(...args),
        },
      });
    };
  }

  stop(): void {
    if (!this.#originalLog) {
      return;
    }

    console.log = this.#originalLog;
    this.#originalLog = undefined;
  }
}
