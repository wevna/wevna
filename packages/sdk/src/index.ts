import type { StartServerOptions } from "@wevna/server";
import type { PgQueryable } from "./pg-instrumentation.js";
import type { RedisSendCommandLike } from "./redis-instrumentation.js";
import { Runtime } from "./runtime.js";

// A single shared Runtime instance is intentional: Wevna mirrors tools like
// Prisma Studio and Storybook, where one local dev server is started per
// process. The SDK is just a thin public-facing wrapper — Runtime owns the
// actual lifecycle.
const runtime = new Runtime();

export const wevna = {
  start(options?: StartServerOptions): Promise<void> {
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
