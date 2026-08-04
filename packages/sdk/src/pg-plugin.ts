import { PgInstrumentation, type PgQueryable } from "./pg-instrumentation.js";
import {
  PLUGIN_API_VERSION,
  type PluginContext,
  type PluginEvent,
  type PluginSetupResult,
  type WevnaPlugin,
} from "./plugin.js";

// A plugin that also accepts targets after registration. instrument() is not
// part of WevnaPlugin — it is this plugin's own configuration surface, the
// same way a community plugin would expose whatever it needs to be told
// about. Runtime holds the one instance and forwards
// wevna.instrumentPg() to it, so the long-standing public API is unchanged.
export interface PgPlugin extends WevnaPlugin {
  instrument(queryable: PgQueryable): void;
}

// node-postgres instrumentation, expressed as a plugin.
//
// The point of routing a built-in through the public plugin API rather than
// straight into Runtime is that a plugin system whose own built-ins bypass
// it rots: if the shipped instrumentation cannot be written against the
// documented surface, no community plugin will manage it either. pg is the
// right one to prove it with, because it has the exact shape a third-party
// plugin will have — opt-in, handed a client object by the developer,
// wrapping a method on it — unlike console/HTTP/exception capture, which are
// always-on with nothing to be handed.
//
// It also demonstrates the surface is sufficient: nothing here reaches past
// PluginContext, and publishing lost the per-event randomUUID()/Date.now()
// bookkeeping it used to carry, because context.publish() stamps both.
export function createPgPlugin(): PgPlugin {
  // Undefined until setup() runs, and again after teardown. instrument() can
  // legitimately be called before Wevna has started (the documented
  // behaviour of wevna.instrumentPg), so a query that settles while there is
  // no context simply publishes nothing — a real query must never fail
  // because Wevna was not listening.
  let publish: ((event: PluginEvent) => void) | undefined;

  const instrumentation = new PgInstrumentation((event) => {
    publish?.(event);
  });

  return {
    name: "wevna:pg",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    eventKinds: ["sql.query"],

    setup(context: PluginContext): PluginSetupResult {
      publish = context.publish;
      // Deliberately does not unwrap the developer's query() method: the
      // wrapper stays installed and goes quiet. Restoring the original
      // would be wrong here, because instrument() may have been called on a
      // pool that outlives this Runtime, and a later start() has no way to
      // re-wrap something it was never handed again.
      return () => {
        publish = undefined;
      };
    },

    instrument(queryable: PgQueryable): void {
      instrumentation.instrument(queryable);
    },
  };
}
