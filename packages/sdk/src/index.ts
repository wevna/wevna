import type { PgQueryable } from "./pg-instrumentation.js";
import type { PluginDescriptor, WevnaPlugin } from "./plugin.js";
import type { RedisSendCommandLike } from "./redis-instrumentation.js";
import { Runtime } from "./runtime.js";
import type { WevnaStartOptions } from "./start-options.js";

// A single shared Runtime instance is intentional: Wevna mirrors tools like
// Prisma Studio and Storybook, where one local dev server is started per
// process. The SDK is just a thin public-facing wrapper — Runtime owns the
// actual lifecycle.
const runtime = new Runtime();

export const wevna = {
  start(options?: WevnaStartOptions): Promise<void> {
    return runtime.start(options);
  },
  stop(): Promise<void> {
    return runtime.stop();
  },
  // Database instrumentation can't be auto-installed the way console/HTTP
  // are (there's no global "every pg.Pool" to patch), so it's opt-in: pass
  // your own Pool/Client or ioredis instance once, anywhere in your app's
  // startup — before or after start() — and it publishes sql.query /
  // redis.command events for every call from then on.
  instrumentPg(queryable: PgQueryable): void {
    runtime.instrumentPg(queryable);
  },
  instrumentRedis(client: RedisSendCommandLike): void {
    runtime.instrumentRedis(client);
  },
  // Registers a plugin — the supported way to teach Wevna about anything it
  // doesn't instrument itself (see plugin.ts). Call it anywhere in startup,
  // before or after start(). Never throws: a plugin Wevna can't use is
  // reported through `wevna.plugins` rather than breaking your app.
  use(plugin: WevnaPlugin): void {
    runtime.use(plugin);
  },
  // Every registered plugin and its status — the answer to "is my plugin
  // actually running, and if not, why".
  get plugins(): readonly PluginDescriptor[] {
    return runtime.plugins;
  },
  // Resolves once no plugin setup is still in flight. use() is synchronous
  // by design, so this exists for code that genuinely needs to wait for
  // plugins to be live before continuing.
  pluginsSettled(): Promise<void> {
    return runtime.pluginsSettled();
  },
  // Records the live protocol stream to filePath, in order, as it's
  // published — see session-recorder.ts. Entirely opt-in: a session that
  // never calls this behaves exactly as it did before this existed. Not
  // replay — this only writes a portable recording file; nothing reads one
  // back yet.
  startRecording(filePath: string): Promise<void> {
    return runtime.startRecording(filePath);
  },
  stopRecording(): Promise<void> {
    return runtime.stopRecording();
  },
  get isRecording(): boolean {
    return runtime.isRecording;
  },
};

// Exception capture. Process-level uncaughtException/unhandledRejection
// coverage is automatic (no wiring needed, same as console/HTTP), and
// wevnaFastifyEnrichment (above) already captures anything Fastify catches
// internally. Express has no equivalent hook to patch, so this is the one
// piece of exception capture that needs an explicit registration step —
// see exception-instrumentation.ts / express-error-handler.ts for why.
export { type ExpressNextFunction, wevnaExpressErrorHandler } from "./express-error-handler.js";
// Framework enrichment layers a developer wires into their own app to get
// richer http.request attributes (framework/route/handler). Express needs
// none of these — its route data is already readable directly off the raw
// request HttpInstrumentation observes, so it's applied automatically with
// no developer action required.
export { wevnaFastifyEnrichment } from "./fastify-enrichment.js";
export {
  type NestCallHandlerLike,
  type NestExecutionContextLike,
  WevnaNestInterceptor,
} from "./nest-enrichment.js";
export type {
  OpenedRecording,
  OpenRecordingOptions,
  OpenRecordingResult,
} from "./open-recording.js";
// Session loading — offline inspection of a previously recorded session
// (see startRecording above). Deliberately a standalone function rather
// than part of the `wevna` object above: it starts its own local server
// against a recording file, independent of (and not requiring) a live
// Runtime, so it doesn't share that object's "one live session per
// process" lifecycle. Not replay — this only opens the file and serves its
// events through the same dashboard the live path uses; nothing controls
// playback timing.
export { openRecording } from "./open-recording.js";
// The plugin authoring surface. Everything a plugin needs to be written
// against lives here and nowhere else — a plugin that only imports these
// types keeps working across any Wevna release that doesn't bump
// PLUGIN_API_VERSION.
export {
  PLUGIN_API_VERSION,
  type PluginContext,
  type PluginDescriptor,
  type PluginEvent,
  type PluginLogger,
  type PluginSetupResult,
  type PluginStatus,
  type PluginTeardown,
  type WevnaPlugin,
} from "./plugin.js";
export type {
  OpenSessionResult,
  ReadEventResult,
  RecordedEvent,
  SessionLoaderError,
  SessionLoaderErrorType,
  SessionLoaderIssue,
  SessionMetadata,
} from "./session-loader.js";
export { SessionLoader } from "./session-loader.js";
export type { WevnaStartOptions } from "./start-options.js";
