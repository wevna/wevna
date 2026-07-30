import type http from "node:http";
import { captureException } from "./exception-instrumentation.js";

// Structurally compatible with Express's 4-arg error-handling middleware
// signature — deliberately not typed against the express package, the same
// way express-enrichment.ts avoids it, so using this doesn't force a
// dependency on express for consumers who don't need it.
export type ExpressNextFunction = (err?: unknown) => void;

// Express (verified against v5, which — unlike v4 — also catches a
// rejected async handler automatically) catches a route handler's
// thrown/rejected error internally and finishes the response itself,
// before Wevna's HttpInstrumentation ever gets a chance to see the error
// object — only the resulting statusCode. There's no lower-level hook to
// patch the way HttpInstrumentation patches http.Server.prototype.emit,
// so getting at the actual Error requires this: a normal Express
// error-handling middleware, registered like any other.
//
// Register it after your routes, alongside (or instead of) your own error
// handling — it only observes and always calls next(err), so it never
// changes what response Express (or your own error handler, registered
// after this one) ends up sending. Verified empirically that this
// preserves the exact status code and body Express would have sent
// without it, for both a synchronous throw and an async rejection.
export function wevnaExpressErrorHandler(
  err: unknown,
  _req: http.IncomingMessage,
  _res: http.ServerResponse,
  next: ExpressNextFunction,
): void {
  captureException(err, { framework: "express" });
  next(err);
}
