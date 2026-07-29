import type http from "node:http";
import { enrichHttpRequest } from "./http-instrumentation.js";

// Structurally compatible with Nest's real ExecutionContext/CallHandler —
// deliberately not imported from @nestjs/common, so using this doesn't
// force every SDK consumer to install Nest. A real ExecutionContext/
// CallHandler satisfies these shapes.
export interface NestExecutionContextLike {
  switchToHttp(): { getRequest(): unknown };
  getClass(): { name: string };
  getHandler(): { name: string };
}

export interface NestCallHandlerLike {
  handle(): unknown;
}

function getRawRequest(request: unknown): http.IncomingMessage | undefined {
  if (!request || typeof request !== "object") {
    return undefined;
  }
  // Nest-on-Fastify wraps the raw request as `.raw` (same as plain
  // Fastify); Nest-on-Express *is* the raw request (same as plain
  // Express) — either way this ends up as the same object
  // HttpInstrumentation already holds.
  const raw = (request as { raw?: unknown }).raw;
  return (raw && typeof raw === "object" ? raw : request) as http.IncomingMessage;
}

// Wire into a Nest app with `app.useGlobalInterceptors(new
// WevnaNestInterceptor())` to get framework/handler attributes attached to
// its http.request events, layered on top of whatever the underlying
// Express or Fastify adapter already contributes (route in particular
// keeps coming from that layer — this only adds what's uniquely available
// from Nest's own execution context). Never throws and never blocks the
// request: if the shape doesn't match what's expected, enrichment is
// silently skipped and the base HTTP event still publishes.
export class WevnaNestInterceptor {
  intercept(context: NestExecutionContextLike, next: NestCallHandlerLike): unknown {
    try {
      const raw = getRawRequest(context.switchToHttp().getRequest());
      if (raw) {
        enrichHttpRequest(raw, {
          framework: "nestjs",
          handler: `${context.getClass().name}.${context.getHandler().name}`,
        });
      }
    } catch {
      // Metadata couldn't be discovered cleanly — fall through and let the
      // base HTTP event publish without it.
    }

    return next.handle();
  }
}
