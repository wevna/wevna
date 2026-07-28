import type { Session } from "@wevna/protocol";
import { type StartedServer, type StartServerOptions, startServer } from "@wevna/server";
import { createSession, stopSession } from "./session.js";

// Runtime is the single owner of Wevna's application lifecycle. As Wevna
// grows, it's where the server, transport, instrumentation, session
// management, storage, and plugins all get coordinated together in a
// defined startup/shutdown order — the SDK itself stays a thin,
// publicly-facing wrapper around it. Only the server and the current
// session exist so far. Future milestones attach to Runtime, not to the
// SDK.
export type RuntimeState = "stopped" | "starting" | "running" | "stopping";

export class Runtime {
  #state: RuntimeState = "stopped";
  #server: StartedServer | undefined;
  #session: Session | undefined;
  #startPromise: Promise<void> | undefined;

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

    try {
      this.#server = await startServer(options);
    } catch (error) {
      this.#state = "stopped";
      this.#session = undefined;
      throw error;
    }

    // Future subsystems (transport, instrumentation, storage, plugins)
    // start here, after the server, in dependency order.

    this.#state = "running";
    console.log(`Wevna running at ${this.#server.url}`);
  }

  async stop(): Promise<void> {
    if (!this.#server) {
      return;
    }

    this.#state = "stopping";
    console.log("Stopping Wevna...");

    if (this.#session) {
      this.#session = stopSession(this.#session);
    }

    // Future subsystems stop here, before the server, in reverse startup
    // order.

    const server = this.#server;
    this.#server = undefined;
    await server.stop();

    this.#state = "stopped";
    console.log("Wevna stopped.");
  }
}
