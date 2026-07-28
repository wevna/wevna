import { type StartedServer, type StartServerOptions, startServer } from "@wevna/server";

// Runtime is the single owner of Wevna's application lifecycle. As Wevna
// grows, it's where the server, transport, instrumentation, session
// management, storage, and plugins all get coordinated together in a
// defined startup/shutdown order — the SDK itself stays a thin,
// publicly-facing wrapper around it. None of those other subsystems exist
// yet; only the server does. Future milestones attach to Runtime, not to
// the SDK.
export type RuntimeState = "stopped" | "starting" | "running" | "stopping";

export class Runtime {
  #state: RuntimeState = "stopped";
  #server: StartedServer | undefined;
  #startPromise: Promise<void> | undefined;

  get state(): RuntimeState {
    return this.#state;
  }

  get isRunning(): boolean {
    return this.#state === "running";
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

    try {
      this.#server = await startServer(options);
    } catch (error) {
      this.#state = "stopped";
      throw error;
    }

    // Future subsystems (transport, instrumentation, sessions, storage,
    // plugins) start here, after the server, in dependency order.

    this.#state = "running";
    console.log(`Wevna running at ${this.#server.url}`);
  }

  async stop(): Promise<void> {
    if (!this.#server) {
      return;
    }

    this.#state = "stopping";
    console.log("Stopping Wevna...");

    // Future subsystems stop here, before the server, in reverse startup
    // order.

    const server = this.#server;
    this.#server = undefined;
    await server.stop();

    this.#state = "stopped";
    console.log("Wevna stopped.");
  }
}
