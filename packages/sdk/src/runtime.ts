import {
  type CapturedEvent,
  type Correlation,
  type Envelope,
  PROTOCOL_VERSION,
  type Session,
} from "@wevna/protocol";
import { type StartedServer, startServer } from "@wevna/server";
import { ConsoleInstrumentation } from "./console-instrumentation.js";
import * as correlationContext from "./correlation-context.js";
import { EventBus } from "./event-bus.js";
import { ExceptionInstrumentation } from "./exception-instrumentation.js";
import { HttpInstrumentation } from "./http-instrumentation.js";
import type { PgQueryable } from "./pg-instrumentation.js";
import { createPgPlugin } from "./pg-plugin.js";
import type { PluginDescriptor, WevnaPlugin } from "./plugin.js";
import { PluginManager } from "./plugin-manager.js";
import type { RedisSendCommandLike } from "./redis-instrumentation.js";
import { createRedisPlugin } from "./redis-plugin.js";
import { createSession, stopSession } from "./session.js";
import { SessionRecorder } from "./session-recorder.js";
import type { WevnaStartOptions } from "./start-options.js";

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
  // Registers process-level 'uncaughtException'/'unhandledRejection'
  // listeners once running — see exception-instrumentation.ts for why
  // those, plus the minimal Express/Fastify hooks, are the two coverage
  // paths, and for the documented side effect on default crash behaviour.
  readonly #exceptionInstrumentation = new ExceptionInstrumentation((event) => this.publish(event));
  // Unlike console/HTTP, these can't be auto-installed: there's no global
  // "every pg.Pool" or "every ioredis client" hook to patch, so a developer
  // must hand us their own instance via instrumentPg()/instrumentRedis().
  //
  // Both now reach the event stream through the public plugin api rather
  // than calling this.publish() directly — see pg-plugin.ts for why the
  // shipped instrumentation deliberately eats its own dog food. Registered
  // in the constructor so they are set up by startAll() in the same pass as
  // any developer-registered plugin, with no special-casing anywhere in
  // PluginManager.
  readonly #pgPlugin = createPgPlugin();
  readonly #redisPlugin = createRedisPlugin();
  // Independent EventBus subscriber, wired up only when startRecording()
  // is called — see session-recorder.ts for why it's never coupled to the
  // WebSocket transport. Recording is entirely opt-in: a developer who
  // never calls startRecording() sees no behavioural change at all.
  readonly #sessionRecorder = new SessionRecorder();
  // Third-party event producers. Given the same narrow host surface every
  // built-in producer effectively has (publish + correlation), rather than a
  // reference to Runtime itself — so what plugins depend on is a documented
  // contract, not whatever happens to be public on this class.
  //
  // publish() is lifecycle-guarded here for the same reason
  // instrumentPg/instrumentRedis are: a plugin can be registered before
  // start() or observe an operation after stop(), and neither must throw
  // inside the developer's own code path.
  readonly #pluginManager = new PluginManager({
    publish: (event) => {
      if (this.isRunning) {
        this.publish(event);
      }
    },
    currentCorrelation: () => correlationContext.currentCorrelation(),
    startCorrelation: (fn) => correlationContext.startCorrelation(fn),
    runWithCorrelation: (correlation, fn) => correlationContext.runWithCorrelation(correlation, fn),
  });

  constructor() {
    // The built-in producers are registered first, so they always appear
    // ahead of developer-registered plugins in `plugins` and are torn down
    // after them.
    this.#pluginManager.register(this.#pgPlugin);
    this.#pluginManager.register(this.#redisPlugin);
  }

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

  // Whether a session recording is currently active. Exposed publicly (see
  // index.ts) as the one piece of recording status a developer might want
  // to check — there is no dashboard surface for this milestone.
  get isRecording(): boolean {
    return this.#sessionRecorder.isRecording;
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

  // Registers a plugin. Safe at any point in the lifecycle: before start()
  // the plugin is set up when the runtime starts, after it the plugin is set
  // up immediately. Never throws — an unusable plugin (wrong api version,
  // duplicate name, failing setup) is recorded as failed and reported via
  // `plugins` rather than breaking the application's startup.
  use(plugin: WevnaPlugin): void {
    this.#pluginManager.register(plugin);
  }

  // Every registered plugin and what became of it. The answer to "is my
  // plugin actually running, and if not, why" without needing to reproduce
  // an event.
  get plugins(): readonly PluginDescriptor[] {
    return this.#pluginManager.descriptors;
  }

  // Resolves once no plugin setup is still in flight. use() is deliberately
  // synchronous — startup code calls it without awaiting — so this is how a
  // caller that genuinely needs plugins live (a test, or code that wants to
  // assert on `plugins`) waits for them.
  pluginsSettled(): Promise<void> {
    return this.#pluginManager.settled();
  }

  // Wraps a pg Pool or Client's query() to publish sql.query events. Safe
  // to call at any point in Runtime's lifecycle, and safe to call more
  // than once with the same instance (a no-op past the first call).
  instrumentPg(queryable: PgQueryable): void {
    this.#pgPlugin.instrument(queryable);
  }

  // Wraps an ioredis client's sendCommand() to publish redis.command
  // events. Same safety guarantees as instrumentPg().
  instrumentRedis(client: RedisSendCommandLike): void {
    this.#redisPlugin.instrument(client);
  }

  // Starts recording the live protocol stream to filePath as it's
  // published — see session-recorder.ts. Requires a running session (the
  // recording's header needs one to describe), unlike instrumentPg/
  // instrumentRedis which can be called at any point in Runtime's
  // lifecycle; matches publish()'s own "cannot do this before a session
  // exists" guard for the same reason. Safe to call while already
  // recording (a no-op — see SessionRecorder.start()).
  async startRecording(filePath: string): Promise<void> {
    if (!this.#session) {
      throw new Error("Cannot start recording before Runtime has started a session.");
    }
    await this.#sessionRecorder.start(this.#eventBus, this.#session, filePath);
  }

  // Safe to call even when not recording. Resolves once the recording file
  // is fully flushed and closed.
  async stopRecording(): Promise<void> {
    await this.#sessionRecorder.stop();
  }

  async start(options?: WevnaStartOptions): Promise<void> {
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

  async #performStart(options?: WevnaStartOptions): Promise<void> {
    this.#state = "starting";
    console.log("Starting Wevna...");

    this.#session = createSession();
    this.#sequence = 0;

    try {
      // eventSource is supplied here and is deliberately not something a
      // caller can override — see start-options.ts. Fields are listed
      // explicitly rather than spread, so a new server option can never
      // become part of Wevna's public API just by existing.
      this.#server = await startServer({
        port: options?.port,
        host: options?.host,
        dashboardDir: options?.dashboardDir,
        eventSource: this.#eventBus,
      });
    } catch (error) {
      this.#state = "stopped";
      this.#session = undefined;
      throw error;
    }

    this.#state = "running";
    console.log(`Wevna running at ${this.#server.url}`);

    // Future subsystems (storage) start here, after Runtime's own startup
    // logging, so its own log lines are never captured as instrumented
    // events. The WebSocket transport is not one of them: it lives entirely
    // inside the server, which subscribes to #eventBus itself (passed in
    // above) — Runtime stays unaware of WebSockets.
    this.#consoleInstrumentation.start();
    // The dashboard's own server is excluded so its asset/health/WS-upgrade
    // traffic never shows up as a captured event — only the developer's
    // own HTTP servers are observed.
    this.#httpInstrumentation.start({ ignoreServers: [this.#server.app.server] });
    this.#exceptionInstrumentation.start();
    // Plugins start last, so a plugin's own setup can rely on every
    // built-in producer already being live — and so a plugin that logs
    // during setup produces captured events like any other application
    // code would, rather than silently vanishing.
    await this.#pluginManager.startAll();
  }

  async stop(): Promise<void> {
    if (!this.#server) {
      return;
    }

    this.#state = "stopping";

    // Future subsystems stop here, before Runtime's own shutdown logging
    // (reverse of the startup order above), so its own log lines are never
    // captured as instrumented events. Plugins first, mirroring the startup
    // order: they were set up last, so they are unwound first, while the
    // built-in producers they may have relied on are still live.
    await this.#pluginManager.stopAll();
    this.#consoleInstrumentation.stop();
    this.#httpInstrumentation.stop();
    this.#exceptionInstrumentation.stop();
    // Finalizes (footer + flush + close) any recording still in progress,
    // so stopping Wevna mid-recording never leaves a file without its
    // footer for no reason — a no-op if nothing was recording. Placed
    // after instrumentation stops, same as everything else here, so the
    // recording never includes Wevna's own shutdown log line below.
    await this.#sessionRecorder.stop();

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
