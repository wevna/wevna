import { randomUUID } from "node:crypto";
import http from "node:http";
import { performance } from "node:perf_hooks";
import type { CapturedEvent } from "@wevna/protocol";

export type PublishCapturedEvent = (event: CapturedEvent) => void;

export interface HttpInstrumentationStartOptions {
  // Servers to never capture traffic for — namely Wevna's own dashboard
  // server, so its own asset/health/WS-upgrade traffic never shows up as a
  // captured event.
  ignoreServers?: Iterable<http.Server>;
}

type ServerEmit = typeof http.Server.prototype.emit;

// Wevna's second producer: observes Node's raw HTTP layer, below any
// framework, so it works under Express, Fastify, NestJS, or a bare
// http.Server without framework-specific integration. One incoming request
// produces exactly one CapturedEvent, published once its response finishes.
export class HttpInstrumentation {
  readonly #publish: PublishCapturedEvent;
  #originalEmit: ServerEmit | undefined;
  #ignoredServers = new Set<http.Server>();

  constructor(publish: PublishCapturedEvent) {
    this.#publish = publish;
  }

  start(options: HttpInstrumentationStartOptions = {}): void {
    if (this.#originalEmit) {
      return;
    }

    this.#ignoredServers = new Set(options.ignoreServers ?? []);
    const originalEmit = http.Server.prototype.emit;
    this.#originalEmit = originalEmit;
    const publish = this.#publish;
    const ignoredServers = this.#ignoredServers;

    // Patching http.Server.prototype.emit (rather than each server
    // instance) catches every server regardless of when it was created
    // relative to Runtime.start(), and works for any framework built on
    // top of node:http — they all still emit "request" on the underlying
    // server.
    http.Server.prototype.emit = function patchedEmit(
      this: http.Server,
      event: string,
      ...args: unknown[]
    ): boolean {
      if (event === "request" && !ignoredServers.has(this)) {
        const [req, res] = args as [http.IncomingMessage, http.ServerResponse];
        const startedAt = performance.now();

        res.once("finish", () => {
          publish({
            id: randomUUID(),
            kind: "http.request",
            occurredAt: Date.now(),
            attributes: {
              method: req.method ?? "",
              url: req.url ?? "",
              statusCode: res.statusCode,
              durationMs: performance.now() - startedAt,
            },
          });
        });
      }

      return originalEmit.apply(this, [event, ...args] as Parameters<ServerEmit>);
    };
  }

  stop(): void {
    if (!this.#originalEmit) {
      return;
    }

    http.Server.prototype.emit = this.#originalEmit;
    this.#originalEmit = undefined;
    this.#ignoredServers.clear();
  }
}
