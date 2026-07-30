import { randomUUID } from "node:crypto";
import type { CapturedEvent } from "@wevna/protocol";

export type PublishCapturedEvent = (event: CapturedEvent) => void;

function describeError(error: unknown): {
  name: string;
  message: string;
  stack: string | undefined;
} {
  if (error instanceof Error) {
    // Preserved exactly as V8 generated it — no source mapping or
    // symbolication, both explicitly out of scope for this milestone.
    return { name: error.name, message: error.message, stack: error.stack };
  }
  // Something other than an Error was thrown/rejected with (a string, a
  // plain object, ...) — still worth capturing, just without a stack.
  return { name: "NonErrorThrown", message: String(error), stack: undefined };
}

// The one instance Runtime owns is registered here so framework glue
// (express/fastify integration) can call captureException() as a plain,
// dependency-free function — exactly like correlation-context.ts's module-
// level currentCorrelation() — without importing Runtime itself or
// creating a circular dependency between it and the framework-integration
// files it re-exports. A no-op before Runtime has started or after it's
// stopped, matching instrumentPg/instrumentRedis's safety guarantee: a
// real error must never throw just because Wevna isn't running.
let activeInstrumentation: ExceptionInstrumentation | undefined;

export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  activeInstrumentation?.capture(error, extra);
}

// Wevna's exception producer. Unlike console/HTTP, most exceptions can't be
// observed generically below any framework — Express and Fastify both
// catch handler errors internally (verified empirically: neither leaks a
// route handler's thrown/rejected error to the process, in Express 5 or
// Fastify) and finish the response themselves, so there's no single hook
// this class can patch the way HttpInstrumentation patches
// http.Server.prototype.emit. Coverage instead comes from three
// complementary sources:
//
//   1. HttpInstrumentation itself catches a synchronous throw from request
//      dispatch (see http-instrumentation.ts) and calls captureException()
//      immediately, still inside the same synchronous call stack
//      startCorrelation established, before rethrowing unchanged. This
//      matters because — verified empirically — by the time the same
//      exception would otherwise reach 'uncaughtException' below,
//      AsyncLocalStorage no longer reports the correlation that was active
//      one frame up; catching it here is what keeps it correlated.
//   2. process-level 'uncaughtException'/'unhandledRejection' — the
//      framework-agnostic baseline for everything else (a rejected async
//      handler nobody awaited; a throw with no HTTP request involved at
//      all). Verified empirically that AsyncLocalStorage correlation *is*
//      still readable from inside an 'unhandledRejection' handler — unlike
//      uncaughtException, a rejection's causality is tracked through the
//      promise chain itself. An exception already captured by (1) is
//      deduped here (see #alreadyCaptured below) rather than published
//      twice once it inevitably also reaches this listener.
//   3. captureException(), called directly from minimal, additive
//      framework hooks (Fastify's onError hook; an opt-in Express error
//      middleware) that observe an error the framework caught internally,
//      without altering the response the framework already sends.
//
// All three funnel through capture() below, so the actual event shape is
// defined in exactly one place.
export class ExceptionInstrumentation {
  readonly #publish: PublishCapturedEvent;
  #onUncaughtException: ((error: Error) => void) | undefined;
  #onUnhandledRejection: ((reason: unknown) => void) | undefined;
  // Errors are reference-stable, so the same thrown Error reaching capture()
  // twice (e.g. HttpInstrumentation's dispatch catch, then again via
  // 'uncaughtException' once it finishes propagating) is detectable by
  // identity — WeakSet so a long-lived process never accumulates memory for
  // errors it's already forgotten about otherwise.
  #alreadyCaptured = new WeakSet<WeakKey>();

  constructor(publish: PublishCapturedEvent) {
    this.#publish = publish;
  }

  start(): void {
    if (this.#onUncaughtException) {
      return;
    }

    // Registering these listeners has one real side effect worth being
    // explicit about: Node's default behaviour for an uncaught exception
    // or unhandled rejection with *no* listener is to crash the process.
    // Adding any listener — including this one — disables that default,
    // the same way it would if the application registered its own. Wevna
    // does not attempt to reinstate it (e.g. by calling process.exit()
    // itself): doing that safely requires guaranteeing the just-published
    // event has actually been flushed first, which is a correctness
    // problem of its own and out of scope for "observe, don't act on the
    // app's behalf." If the application doesn't already handle these
    // itself, capturing an exception here means the process now stays up
    // where it previously would have exited — documented, not silent.
    const onUncaughtException = (error: Error): void => {
      this.capture(error, { origin: "uncaughtException" });
    };
    const onUnhandledRejection = (reason: unknown): void => {
      this.capture(reason, { origin: "unhandledRejection" });
    };

    process.on("uncaughtException", onUncaughtException);
    process.on("unhandledRejection", onUnhandledRejection);
    this.#onUncaughtException = onUncaughtException;
    this.#onUnhandledRejection = onUnhandledRejection;
    activeInstrumentation = this;
  }

  stop(): void {
    if (this.#onUncaughtException) {
      process.off("uncaughtException", this.#onUncaughtException);
      this.#onUncaughtException = undefined;
    }
    if (this.#onUnhandledRejection) {
      process.off("unhandledRejection", this.#onUnhandledRejection);
      this.#onUnhandledRejection = undefined;
    }
    if (activeInstrumentation === this) {
      activeInstrumentation = undefined;
    }
  }

  // The one place an exception becomes a CapturedEvent — negligible cost
  // until actually called: no wrapping, no try/catch installed anywhere
  // ahead of time, just building one object and handing it to publish().
  capture = (error: unknown, extra?: Record<string, unknown>): void => {
    if (typeof error === "object" && error !== null) {
      if (this.#alreadyCaptured.has(error)) {
        return;
      }
      this.#alreadyCaptured.add(error);
    }

    const { name, message, stack } = describeError(error);
    this.#publish({
      id: randomUUID(),
      kind: "exception.captured",
      occurredAt: Date.now(),
      attributes: {
        name,
        message,
        ...(stack !== undefined ? { stack } : {}),
        ...extra,
      },
    });
  };
}
