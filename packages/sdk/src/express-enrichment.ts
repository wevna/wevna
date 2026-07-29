import type http from "node:http";
import type { HttpEnrichment } from "./http-instrumentation.js";

interface ExpressRouteLayer {
  name?: unknown;
}

interface ExpressRoute {
  path?: unknown;
  stack?: ExpressRouteLayer[];
}

interface ExpressRequest extends http.IncomingMessage {
  route?: ExpressRoute;
}

// Express mutates the same raw request object Node's http.Server hands to
// HttpInstrumentation (it doesn't wrap it, unlike Fastify), so by the time
// a response finishes, whatever route Express matched is already sitting
// on req.route — no separate hook or plugin needed. Never throws: if the
// shape isn't what's expected (a different framework, or an Express
// version that changed internals), enrichment is simply skipped and the
// base http.request event still publishes with just
// method/url/statusCode/durationMs.
export function detectExpressEnrichment(req: http.IncomingMessage): HttpEnrichment | undefined {
  try {
    const route = (req as ExpressRequest).route;
    if (!route || typeof route.path !== "string") {
      return undefined;
    }

    const handlerName = route.stack?.at(-1)?.name;
    const enrichment: HttpEnrichment = { framework: "express", route: route.path };
    if (
      typeof handlerName === "string" &&
      handlerName.length > 0 &&
      handlerName !== "<anonymous>"
    ) {
      enrichment.handler = handlerName;
    }
    return enrichment;
  } catch {
    return undefined;
  }
}
