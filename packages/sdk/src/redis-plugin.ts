import {
  PLUGIN_API_VERSION,
  type PluginContext,
  type PluginEvent,
  type PluginSetupResult,
  type WevnaPlugin,
} from "./plugin.js";
import { RedisInstrumentation, type RedisSendCommandLike } from "./redis-instrumentation.js";

// See PgPlugin: instrument() is this plugin's own configuration surface, not
// part of WevnaPlugin.
export interface RedisPlugin extends WevnaPlugin {
  instrument(client: RedisSendCommandLike): void;
}

// ioredis instrumentation, expressed as a plugin — same rationale as
// createPgPlugin(). Two independent built-ins going through the public
// surface is a better test of it than one: it is what shows the api isn't
// quietly shaped around a single producer's needs.
export function createRedisPlugin(): RedisPlugin {
  let publish: ((event: PluginEvent) => void) | undefined;

  const instrumentation = new RedisInstrumentation((event) => {
    publish?.(event);
  });

  return {
    name: "wevna:redis",
    version: "1.0.0",
    apiVersion: PLUGIN_API_VERSION,
    eventKinds: ["redis.command"],

    setup(context: PluginContext): PluginSetupResult {
      publish = context.publish;
      return () => {
        publish = undefined;
      };
    },

    instrument(client: RedisSendCommandLike): void {
      instrumentation.instrument(client);
    },
  };
}
