import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type CapturedEvent,
  type Envelope,
  PROTOCOL_VERSION,
  RECORDING_FORMAT_VERSION,
  type RecordingLine,
  type Session,
} from "@wevna/protocol";
import type { EventBus } from "./event-bus.js";

// Sits alongside the WebSocket transport as an independent EventBus
// subscriber, not layered on top of or coupled to it in any way — recording
// never touches, imports, or is imported by anything in @wevna/server, so
// starting, stopping, or a recording failure never affects the live
// dashboard connection, and vice versa.
//
// Writes JSON Lines (see RecordingLine in @wevna/protocol for the file
// format itself and why it's line-oriented). record() is called
// synchronously, directly from an EventBus subscription: EventBus.publish()
// calls every listener synchronously, in registration order, and nothing
// here defers to a microtask in between, so lines land in the file in
// exactly the order events were published — including under concurrent,
// overlapping requests, since the actual writes are still dispatched one
// at a time on Node's single thread.
//
// stream.write() queues the write and returns immediately rather than
// blocking on disk I/O, so recording adds negligible overhead to the
// synchronous call path every producer (console, HTTP, pg, Redis, an
// uncaught exception) publishes through. Backpressure (write() returning
// false because the internal buffer is full) is deliberately left to
// Node's own stream implementation rather than paused/resumed here — the
// alternative is blocking the same synchronous call path this is trying to
// stay off of, and Node's default buffering already keeps a fast producer
// from losing data against a slower disk.
export class SessionRecorder {
  #stream: WriteStream | undefined;
  #unsubscribe: (() => void) | undefined;
  #eventCount = 0;

  get isRecording(): boolean {
    return this.#stream !== undefined;
  }

  get eventCount(): number {
    return this.#eventCount;
  }

  // Idempotent, like Runtime's other start() methods (e.g.
  // HttpInstrumentation.start()) — calling this while already recording is
  // a no-op rather than opening a second, conflicting stream.
  async start(eventBus: EventBus, session: Session, filePath: string): Promise<void> {
    if (this.isRecording) {
      return;
    }

    await mkdir(dirname(filePath), { recursive: true });
    const stream = createWriteStream(filePath, { flags: "a" });

    // Waiting for "ready" (rather than returning immediately) means a
    // caller who awaits start() has a real guarantee recording began: an
    // invalid path or permissions failure rejects here, instead of
    // silently swallowing every event published before the stream
    // happened to finish opening.
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        stream.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        stream.off("ready", onReady);
        reject(error);
      };
      stream.once("ready", onReady);
      stream.once("error", onError);
    });

    // From here on, a write error (disk full, permissions revoked
    // mid-recording, ...) must not take the live pipeline down with it —
    // stop cleanly instead of throwing from inside an EventBus listener.
    stream.on("error", () => {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      this.#stream = undefined;
    });

    this.#eventCount = 0;
    this.#stream = stream;
    this.#writeLine({
      type: "header",
      formatVersion: RECORDING_FORMAT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      session,
      recordingStartedAt: Date.now(),
    });

    this.#unsubscribe = eventBus.subscribe((envelope) => {
      this.#recordEvent(envelope);
    });
  }

  // Safe to call even when not recording (a no-op), and safe to call more
  // than once. Resolves only once the footer and every buffered event have
  // actually been flushed to disk and the file descriptor closed — a
  // caller that awaits stop() can read the file immediately afterward and
  // trust it's complete.
  async stop(): Promise<void> {
    const stream = this.#stream;
    if (!stream) {
      return;
    }

    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#stream = undefined;

    this.#writeLineTo(stream, {
      type: "footer",
      recordingEndedAt: Date.now(),
      eventCount: this.#eventCount,
    });

    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  #recordEvent(envelope: Envelope<CapturedEvent>): void {
    if (!this.#stream) {
      return;
    }
    this.#writeLine({ type: "event", envelope });
    this.#eventCount += 1;
  }

  #writeLine(line: RecordingLine): void {
    if (this.#stream) {
      this.#writeLineTo(this.#stream, line);
    }
  }

  #writeLineTo(stream: WriteStream, line: RecordingLine): void {
    stream.write(`${JSON.stringify(line)}\n`);
  }
}
