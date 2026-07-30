import {
  type CapturedEvent,
  type Correlation,
  type Envelope,
  PROTOCOL_VERSION,
  type Session,
} from "@wevna/protocol";
import { type StartedServer, type StartServerOptions, startServer } from "@wevna/server";
import { ConsoleInstrumentation } from "./console-instrumentation.js";
import * as correlationContext from "./correlation-context.js";
import { EventBus } from "./event-bus.js";
import { HttpInstrumentation } from "./http-instrumentation.js";
import { PgInstrumentation, type PgQueryable } from "./pg-instrumentation.js";
import { RedisInstrumentation, type RedisSendCommandLike } from "./redis-instrumentation.js";
import { createSession, stopSession } from "./session.js";

// Runtime is the single owner of Wevna's application lifecycle. As Wevna
// grows, it's where the server, transport, instrumentation, session
// management, storage, and plugins all get coordinated together in a
// defined startup/shutdown order — the SDK itself stays a thin,
// publicly-facing wrapper around it. Only the server, the current session,
// the internal event bus, console/HTTP/pg/Redis instrumentation, and
// correlation context exist so far. Future milestones attach to Runtime,
// not to the SDK.
export type RuntimeState = "stopped" | "starting" | "running" | "stopping";

export class Runtime {
  #state: RuntimeState = "stopped";
  #server: StartedServer | undefined;
  #session: Session | undefined;
  #startPromise: Promise<void> | undefined;
  // Owned once for the life of this Runtime instance rather than recreated
  // per start/stop cycle: it is pure in-memory infrastructure with no
  // external resource to tear down, and future subscribers (transport,
  // dashboard, storage) should be able to subscribe once and keep receiving
  // events across restarts.
  readonly #eventBus = new EventBus();
  // Reset to 0 whenever a new session is created, so sequence numbers start
  // at 1 for each new runtime session rather than continuing across it.
  #sequence = 0;
  // Runtime's event producers. Each only ever emits CapturedEvent —
  // publish() (below) is what turns that into an Envelope. Instrumentation
  // owns observation; Runtime just wires it to the publisher.
  readonly #consoleInstrumentation = new ConsoleInstrumentation((event) => this.publish(event));
  readonly #httpInstrumentation = new HttpInstrumentation((event) => this.publish(event));
  // Unlike console/HTTP, these can't be auto-installed: there's no global
  // "every pg.Pool" or "every ioredis client" hook to patch, so a developer
  // must hand us their own instance via instrumentPg()/instrumentRedis().
  // That means they can be called before Runtime has ever started (or
  // after it's stopped), so their publish callback guards on isRunning
  // instead of calling this.publish() directly — a real query or command
  // must never throw just because Wevna isn't running.
  readonly #pgInstrumentation = new PgInstrumentation((event) => {
    if (this.isRunning) {
      this.publish(event);
    }
  });
  readonly #redisInstrumentation = new RedisInstrumentation((event) => {
    if (this.isRunning) {
      this.publish(event);
    }
  });

  get state(): RuntimeState {
    return this.#state;
  }

  get isRunning(): boolean {
    return this.#state === "running";
  }

  // The current (or, once stopped, most recent) execution of Wevna. This
  // is the only place a session is tracked — there is no global session
  // state anywhere else.
  get session(): Session | undefined {
    return this.#session;
  }

  // Internal-only: lets other Runtime-owned subsystems publish and
  // subscribe to protocol events. Deliberately not re-exported from the
  // package's public entrypoint (src/index.ts) — this is not part of the
  // public SDK API.
  get eventBus(): EventBus {
    return this.#eventBus;
  }

  // Internal-only: the dashboard server's own bound URL, once running.
  get url(): string | undefined {
    return this.#server?.url;
  }

  // Internal-only: the single place protocol envelopes get constructed.
  // Producers (instrumentation) only ever deal in CapturedEvent — Runtime
  // is solely responsible for stamping the protocol version, attaching
  // the active session, assigning the next sequence number, and — new in
  // this milestone — attaching whichever correlation is active for the
  // calling async flow, before handing the envelope to the event bus.
  //
  // This is the entire mechanism by which every producer (console, HTTP,
  // pg, Redis) gets correlation for free: none of them need to know
  // correlation exists. If a producer already set its own `correlation`
  // (nothing does today), that's honoured over the ambient one. If no
  // correlation is active at all (startup logs, background work outside
  // any request), the event publishes exactly as it did before this
  // milestone — no `correlation` key present.
  publish(event: CapturedEvent): void {
    if (!this.#session) {
      throw new Error("Cannot publish an event before Runtime has started a session.");
    }

    this.#sequence += 1;

    const correlation = event.correlation ?? correlationContext.currentCorrelation();
    const payload: CapturedEvent = correlation ? { ...event, correlation } : event;

    const envelope: Envelope<CapturedEvent> = {
      version: PROTOCOL_VERSION,
      sessionId: this.#session.id,
      sequence: this.#sequence,
      payload,
    };

    this.#eventBus.publish(envelope);
  }

  // Internal-only: exposes the correlation API to other Runtime-owned
  // subsystems (and future instrumentation — queues, workers, ...)
  // without them needing to understand AsyncLocalStorage directly. Not
  // re-exported from the package's public entrypoint.
  currentCorrelation(): Correlation | undefined {
    return correlationContext.currentCorrelation();
  }

  startCorrelation<T>(fn: () => T): T {
    return correlationContext.startCorrelation(fn);
  }

  runWithCorrelation<T>(correlation: Correlation, fn: () => T): T {
    return correlationContext.runWithCorrelation(correlation, fn);
  }

  // Wraps a pg Pool or Client's query() to publish sql.query events. Safe
  // to call at any point in Runtime's lifecycle, and safe to call more
  // than once with the same instance (a no-op past the first call).
  instrumentPg(queryable: PgQueryable): void {
    this.#pgInstrumentation.instrument(queryable);
  }

  // Wraps an ioredis client's sendCommand() to publish redis.command
  // events. Same safety guarantees as instrumentPg().
  instrumentRedis(client: RedisSendCommandLike): void {
    this.#redisInstrumentation.instrument(client);
  }

  async start(options?: StartServerOptions): Promise<void> {
    if (this.#state === "running") {
      return;
    }
    if (!this.#startPromise) {
      this.#startPromise = this.#performStart(options);
    }

    try {
      await this.#startPromise;
    } finally {
      this.#startPromise = undefined;
    }
  }

  async #performStart(options?: StartServerOptions): Promise<void> {
    this.#state = "starting";
    console.log("Starting Wevna...");

    this.#session = createSession();
    this.#sequence = 0;

    try {
      this.#server = await startServer({ ...options, eventSource: this.#eventBus });
    } catch (error) {
      this.#state = "stopped";
      this.#session = undefined;
      throw error;
    }

    this.#state = "running";
    console.log(`Wevna running at ${this.#server.url}`);

    // Future subsystems (storage, plugins) start here, after Runtime's own
    // startup logging, so its own log lines are never captured as
    // instrumented events. The WebSocket transport is not one of them: it
    // lives entirely inside the server, which subscribes to #eventBus
    // itself (passed in above) — Runtime stays unaware of WebSockets.
    this.#consoleInstrumentation.start();
    // The dashboard's own server is excluded so its asset/health/WS-upgrade
    // traffic never shows up as a captured event — only the developer's
    // own HTTP servers are observed.
    this.#httpInstrumentation.start({ ignoreServers: [this.#server.app.server] });
  }

  async stop(): Promise<void> {
    if (!this.#server) {
      return;
    }

    this.#state = "stopping";

    // Future subsystems stop here, before Runtime's own shutdown logging
    // (reverse of the startup order above), so its own log lines are never
    // captured as instrumented events.
    this.#consoleInstrumentation.stop();
    this.#httpInstrumentation.stop();

    console.log("Stopping Wevna...");

    if (this.#session) {
      this.#session = stopSession(this.#session);
    }

    const server = this.#server;
    this.#server = undefined;
    await server.stop();

    this.#state = "stopped";
    console.log("Wevna stopped.");
  }
}
