import { randomUUID } from "node:crypto";
import http from "node:http";
import { performance } from "node:perf_hooks";
import type { CapturedEvent } from "@wevna/protocol";
import { startCorrelation } from "./correlation-context.js";
import { detectExpressEnrichment } from "./express-enrichment.js";

export type PublishCapturedEvent = (event: CapturedEvent) => void;

export interface HttpInstrumentationStartOptions {
  // Servers to never capture traffic for — namely Wevna's own dashboard
  // server, so its own asset/health/WS-upgrade traffic never shows up as a
  // captured event.
  ignoreServers?: Iterable<http.Server>;
}

export interface HttpEnrichment {
  framework?: string;
  route?: string;
  handler?: string;
}

type ServerEmit = typeof http.Server.prototype.emit;

const ENRICHMENT = Symbol("wevna.http.enrichment");

interface EnrichableRequest extends http.IncomingMessage {
  [ENRICHMENT]?: HttpEnrichment;
}

// Framework layers that can't be read directly off the raw request/response
// (Fastify, NestJS) call this — from a hook or interceptor that runs before
// the response finishes — to attach extra attributes onto the in-flight
// request. HttpInstrumentation merges whatever's here into the event it
// publishes; if nothing ever calls this for a given request, the base
// method/url/statusCode/durationMs event still publishes untouched.
export function enrichHttpRequest(req: http.IncomingMessage, enrichment: HttpEnrichment): void {
  const target = req as EnrichableRequest;
  target[ENRICHMENT] = { ...target[ENRICHMENT], ...enrichment };
}

function getHttpEnrichment(req: http.IncomingMessage): HttpEnrichment | undefined {
  return (req as EnrichableRequest)[ENRICHMENT];
}

// Wevna's second producer: observes Node's raw HTTP layer, below any
// framework, so it works under Express, Fastify, NestJS, or a bare
// http.Server without framework-specific integration. One incoming request
// produces exactly one CapturedEvent, published once its response finishes.
// Also establishes a new correlation context for each request (see
// correlation-context.ts) — everything published during that request's
// handling automatically shares its correlation id.
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
      if (event !== "request" || ignoredServers.has(this)) {
        return originalEmit.apply(this, [event, ...args] as Parameters<ServerEmit>);
      }

      const [req, res] = args as [http.IncomingMessage, http.ServerResponse];

      // Every event published while this server dispatches the request —
      // by the framework's route handlers, or by console/pg/Redis
      // instrumentation anywhere in that call chain — automatically
      // inherits this correlation via AsyncLocalStorage, with no changes
      // needed anywhere else: Runtime.publish() attaches whatever
      // correlation is active to every event it publishes. The "finish"
      // listener is registered inside here too (not just the dispatch
      // itself) so the http.request event this instrumentation publishes
      // — fired later, asynchronously — is also correlated with
      // everything else from this same request.
      return startCorrelation(() => {
        const startedAt = performance.now();

        res.once("finish", () => {
          const durationMs = performance.now() - startedAt;
          const occurredAt = Date.now();

          // Deferred one macrotask: HttpInstrumentation registers this
          // "finish" listener synchronously, before the framework has even
          // started handling the request, so it always wins a same-event
          // ordering race against a framework's own "finish"-driven hooks
          // (e.g. Fastify's onResponse is async and does its real work in
          // a microtask after "finish" fires) — verified empirically, not
          // assumed. setImmediate lets those microtasks drain first, so
          // enrichHttpRequest() has actually run by the time we read it.
          setImmediate(() => {
            // Express mutates the same raw req HttpInstrumentation already
            // holds, so its route/handler are readable directly here — no
            // hook needed. Fastify and NestJS wrap the raw request
            // instead, so they enrich it ahead of time via
            // enrichHttpRequest(); that data (if any) wins over the
            // auto-detected Express guess.
            const enrichment = { ...detectExpressEnrichment(req), ...getHttpEnrichment(req) };

            publish({
              id: randomUUID(),
              kind: "http.request",
              occurredAt,
              attributes: {
                method: req.method ?? "",
                url: req.url ?? "",
                statusCode: res.statusCode,
                durationMs,
                ...enrichment,
              },
            });
          });
        });

        return originalEmit.apply(this, [event, ...args] as Parameters<ServerEmit>);
      });
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
