import { type CapturedEvent, type Envelope, PROTOCOL_VERSION, type Session } from "@wevna/protocol";
import { type StartedServer, type StartServerOptions, startServer } from "@wevna/server";
import { ConsoleInstrumentation } from "./console-instrumentation.js";
import { EventBus } from "./event-bus.js";
import { createSession, stopSession } from "./session.js";

// Runtime is the single owner of Wevna's application lifecycle. As Wevna
// grows, it's where the server, transport, instrumentation, session
// management, storage, and plugins all get coordinated together in a
// defined startup/shutdown order — the SDK itself stays a thin,
// publicly-facing wrapper around it. Only the server, the current session,
// the internal event bus, and console instrumentation exist so far. Future
// milestones attach to Runtime, not to the SDK.
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
  // Runtime's first event producer. It only ever emits CapturedEvent —
  // publish() (below) is what turns that into an Envelope.
  readonly #consoleInstrumentation = new ConsoleInstrumentation((event) => this.publish(event));

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

  // Internal-only: the single place protocol envelopes get constructed.
  // Producers (future instrumentation) only ever deal in CapturedEvent —
  // Runtime is solely responsible for stamping the protocol version,
  // attaching the active session, and assigning the next sequence number
  // before handing the envelope to the event bus.
  publish(event: CapturedEvent): void {
    if (!this.#session) {
      throw new Error("Cannot publish an event before Runtime has started a session.");
    }

    this.#sequence += 1;

    const envelope: Envelope<CapturedEvent> = {
      version: PROTOCOL_VERSION,
      sessionId: this.#session.id,
      sequence: this.#sequence,
      payload: event,
    };

    this.#eventBus.publish(envelope);
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
