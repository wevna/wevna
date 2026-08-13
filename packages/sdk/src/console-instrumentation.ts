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
          // Only the formatted string, never the raw argument objects. Two
          // reasons, and either alone would be sufficient. First, the raw
          // values are user-controlled and reach JSON.stringify on the way
          // to a dashboard client: console.log(req) in Express passes a
          // circular object (req.res.req), and console.log(10n) passes a
          // BigInt — both throw from the serializer, which is a throw out
          // of the developer's own console.log() call. Second, they were
          // the one capture surface in Wevna with no redaction of any kind,
          // and nothing ever read them; util.format has already flattened
          // everything a consumer actually displays into `message`.
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
