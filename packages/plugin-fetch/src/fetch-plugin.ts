import { performance } from "node:perf_hooks";
import {
  PLUGIN_API_VERSION,
  type PluginContext,
  type PluginSetupResult,
  type WevnaPlugin,
} from "wevna";
import { describeFetchTarget } from "./sanitize-url.js";

export interface FetchPluginOptions {
  // Hosts to ignore, matched against the request URL's hostname. Useful for
  // keeping a chatty internal dependency (a metrics sink, a health poller)
  // out of the event stream without turning the plugin off entirely.
  ignoreHosts?: readonly string[];
}

// Wevna's outgoing HTTP producer, as a plugin living in its own package.
//
// Being outside packages/sdk is the point: it is the first producer that
// reaches the runtime through nothing but the published plugin api, which is
// what proves the surface is genuinely usable by code Wevna does not ship.
// The only import from `wevna` here is types plus PLUGIN_API_VERSION — no
// Runtime, no EventBus, no internals.
//
// Incoming requests were already the most valuable thing Wevna captured;
// outgoing ones are the other half of the same question, because a request
// that spends 400ms waiting on a third-party API looks identical to a slow
// handler until you can see the call.
//
// Deliberately never records request or response bodies, or any headers.
// Headers are where Authorization and Cookie live, and a body is arbitrary
// user data — same reasoning that keeps Redis command arguments out of
// redis.command events. What is captured is method, sanitized URL, status,
// and duration.
export function createFetchPlugin(options: FetchPluginOptions = {}): WevnaPlugin {
  const ignoreHosts = new Set(options.ignoreHosts ?? []);

  return {
    name: "@wevna/plugin-fetch",
    version: "0.0.1",
    apiVersion: PLUGIN_API_VERSION,
    eventKinds: ["http.client"],

    setup(context: PluginContext): PluginSetupResult {
      // Captured rather than referenced through globalThis at call time, so
      // teardown restores exactly what was there before — and so a second
      // plugin that patched fetch after us still gets called by our wrapper
      // instead of being skipped.
      const originalFetch = globalThis.fetch;
      if (typeof originalFetch !== "function") {
        // Node 18+ always has it; a polyfilled or stripped environment might
        // not. Better to say so once than to publish nothing and look broken.
        context.logger.warn("global fetch is unavailable — outgoing HTTP will not be captured");
        return undefined;
      }

      const instrumented: typeof globalThis.fetch = async (input, init) => {
        const { method, url } = describeFetchTarget(input, init);

        if (ignoreHosts.size > 0 && url) {
          try {
            if (ignoreHosts.has(new URL(url).hostname)) {
              return await originalFetch(input, init);
            }
          } catch {
            // Unparseable target: fall through and observe it. An ignore
            // list should narrow what is captured, never silently widen it.
          }
        }

        const startedAt = performance.now();
        try {
          const response = await originalFetch(input, init);
          context.publish({
            kind: "http.client",
            attributes: {
              method,
              url,
              statusCode: response.status,
              durationMs: performance.now() - startedAt,
            },
          });
          return response;
        } catch (error) {
          // A network-level failure (DNS, refused connection, abort) never
          // reaches a status code, and it is exactly the case a developer is
          // trying to see. Recorded with its message, then rethrown
          // untouched: the caller's own error handling must be unaffected.
          context.publish({
            kind: "http.client",
            attributes: {
              method,
              url,
              durationMs: performance.now() - startedAt,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          throw error;
        }
      };

      globalThis.fetch = instrumented;

      return () => {
        // Only restore if nothing else has patched fetch since. Blindly
        // reassigning would clobber a later wrapper and, worse, silently
        // un-instrument whatever installed it.
        if (globalThis.fetch === instrumented) {
          globalThis.fetch = originalFetch;
        }
      };
    },
  };
}
