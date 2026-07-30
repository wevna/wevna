import type { FastifyPluginCallback } from "fastify";
import fp from "fastify-plugin";
import { captureException } from "./exception-instrumentation.js";
import { enrichHttpRequest } from "./http-instrumentation.js";

// Fastify wraps the raw request rather than mutating it (unlike Express),
// so there's no shared object HttpInstrumentation can read route info off
// after the fact — this plugin is the explicit layering-on-top step that
// makes it possible. Register it on your OWN app, not Wevna's:
// app.register(wevnaFastifyEnrichment).
//
// Wrapped with fastify-plugin: a plain plugin callback gets its own
// encapsulated context, so a hook added inside it would only apply to
// routes registered *inside that same plugin* — never the routes on the
// app it was registered onto. fastify-plugin breaks out of that
// encapsulation, which is the whole point here. Verified this the hard
// way: without it, the onResponse hook silently never fired for routes
// registered on the parent app.
//
// Also verified empirically that HttpInstrumentation defers its read by
// one setImmediate tick specifically so this hook (async, and Fastify
// hooks fire before the raw response's "finish" event only sometimes,
// depending on listener registration order) has always run by the time
// its enrichment is read.
const wevnaFastifyEnrichmentPlugin: FastifyPluginCallback = (app, _opts, done) => {
  app.addHook("onResponse", async (request) => {
    const routePath = request.routeOptions.url;
    if (typeof routePath !== "string") {
      return;
    }

    // Fastify internally binds route handlers, which prefixes the
    // function's own .name with "bound " — strip it so the reported
    // handler name matches what the developer actually wrote.
    const handlerName = request.routeOptions.handler?.name?.replace(/^bound /, "");

    enrichHttpRequest(request.raw, {
      framework: "fastify",
      route: routePath,
      ...(typeof handlerName === "string" && handlerName.length > 0
        ? { handler: handlerName }
        : {}),
    });
  });

  // Fastify catches a route handler's thrown/rejected error internally
  // (verified for both sync and async handlers) and finishes the response
  // itself — onError is Fastify's own dedicated hook for observing that
  // without taking over the response, so this never changes what Fastify
  // sends back.
  app.addHook("onError", async (_request, _reply, error) => {
    captureException(error, { framework: "fastify" });
  });

  done();
};

export const wevnaFastifyEnrichment = fp(wevnaFastifyEnrichmentPlugin, {
  name: "wevna-fastify-enrichment",
});
