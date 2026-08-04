import { randomUUID } from "node:crypto";
import type { CapturedEvent, Correlation } from "@wevna/protocol";
import {
  PLUGIN_API_VERSION,
  type PluginContext,
  type PluginDescriptor,
  type PluginEvent,
  type PluginLogger,
  type PluginStatus,
  type PluginTeardown,
  type WevnaPlugin,
} from "./plugin.js";

// What PluginManager needs from Runtime, and nothing more. Runtime passes
// itself in through this narrow shape rather than the manager importing
// Runtime, which keeps the dependency pointing one way and lets the
// manager's tests drive it without standing up a server.
export interface PluginHost {
  // Already lifecycle-guarded by Runtime: safe to call at any time, drops
  // the event when there is no running session.
  publish(event: CapturedEvent): void;
  currentCorrelation(): Correlation | undefined;
  startCorrelation<T>(fn: () => T): T;
  runWithCorrelation<T>(correlation: Correlation, fn: () => T): T;
}

interface Registration {
  plugin: WevnaPlugin;
  status: PluginStatus;
  error?: string;
  teardown?: PluginTeardown;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Coordinates plugin registration and lifecycle. Its central promise is
// that a badly behaved plugin cannot damage the host: Wevna runs inside a
// developer's own process, often one step from production, so "an
// observability plugin crashed my application" has to be impossible rather
// than unlikely.
//
// Worth being precise about what that protection is, because "plugin
// isolation" usually implies a sandbox and this deliberately is not one.
// Instrumentation works by wrapping the developer's *actual* pg.Pool or
// mongodb client — real references, in-process. A worker thread or vm
// context would put a boundary between the plugin and the objects it exists
// to observe, so the isolation here is fault isolation, not privilege
// isolation: a plugin runs with the full power of the host process, and
// what is guaranteed is only that its failures stay its own. Plugins are
// code you install and trust, exactly like any other dependency.
export class PluginManager {
  readonly #host: PluginHost;
  #registrations: Registration[] = [];
  #running = false;
  // In-flight setup() calls, so a caller can await plugins becoming live
  // without register() itself having to be async — see settled().
  #pending = new Set<Promise<void>>();

  constructor(host: PluginHost) {
    this.#host = host;
  }

  get descriptors(): readonly PluginDescriptor[] {
    return this.#registrations.map(({ plugin, status, error }) => ({
      name: plugin.name,
      version: plugin.version,
      apiVersion: plugin.apiVersion,
      eventKinds: plugin.eventKinds ?? [],
      status,
      ...(error === undefined ? {} : { error }),
    }));
  }

  // Never throws, on any input. A rejected plugin is recorded as "failed"
  // and warned about instead, because the alternative is that adding an
  // observability plugin can crash the application being observed — the
  // same reasoning that makes publish() a no-op when Wevna isn't running.
  // `wevna.plugins` is where a developer sees what was actually accepted.
  register(plugin: WevnaPlugin): void {
    // Checked first and separately: everything below — the failed
    // descriptor, the namespaced warning — needs a name to attach to. With
    // no usable name there is nothing to report through `plugins`, so the
    // warning is the only signal available.
    if (!plugin || typeof plugin !== "object" || typeof plugin.name !== "string" || !plugin.name) {
      console.warn("[wevna] ignored a plugin that is not an object with a name");
      return;
    }

    const rejection = this.#validate(plugin);
    if (rejection) {
      this.#registrations.push({ plugin, status: "failed", error: rejection });
      this.#loggerFor(plugin.name).warn(`not registered — ${rejection}`);
      return;
    }

    const registration: Registration = { plugin, status: "registered" };
    this.#registrations.push(registration);

    // Registered while already running (start() came first): set up now
    // rather than waiting for a restart that may never come.
    if (this.#running) {
      this.#track(this.#setUp(registration));
    }
  }

  // Sets up every plugin still awaiting it, in registration order.
  // Sequential on purpose: plugins routinely patch shared objects, and a
  // deterministic order makes "which plugin wrapped this client first"
  // answerable instead of a race.
  async startAll(): Promise<void> {
    this.#running = true;
    for (const registration of this.#registrations) {
      if (registration.status === "registered") {
        await this.#setUp(registration);
      }
    }
  }

  // Tears down in reverse registration order, so a plugin is always
  // unwound before anything it was set up after. Every teardown is
  // attempted even if an earlier one throws — one plugin failing to clean
  // up must not leave the rest patched.
  async stopAll(): Promise<void> {
    this.#running = false;
    await this.settled();

    for (const registration of [...this.#registrations].reverse()) {
      if (registration.status !== "active") {
        continue;
      }
      const { teardown } = registration;
      // Marked stopped before awaiting: a teardown that throws still leaves
      // the plugin considered torn down, since retrying it would be running
      // failed cleanup code twice.
      registration.status = "stopped";
      registration.teardown = undefined;
      if (!teardown) {
        continue;
      }
      try {
        await teardown();
      } catch (error) {
        this.#loggerFor(registration.plugin.name).error("teardown failed", error);
      }
    }
  }

  // Resolves once no setup() is still in flight. Exists because register()
  // is synchronous — a developer calls wevna.use(plugin) in startup code
  // without awaiting — while setup() may be async.
  async settled(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending]);
    }
  }

  // Assumes register() has already established that `plugin` is an object
  // with a non-empty name.
  #validate(plugin: WevnaPlugin): string | undefined {
    if (typeof plugin.setup !== "function") {
      return "missing a setup() function";
    }
    if (plugin.apiVersion !== PLUGIN_API_VERSION) {
      // Exact match, not >=: a plugin built against a *newer* api than this
      // runtime knows will expect context methods that do not exist here,
      // and one built against an older api may rely on behaviour that
      // changed. Either way the honest answer is "this pairing is
      // unsupported", not a guess.
      return `built for plugin api version ${String(plugin.apiVersion)}, but this runtime supports ${PLUGIN_API_VERSION}`;
    }
    const clash = this.#registrations.find(
      (existing) => existing.plugin.name === plugin.name && existing.status !== "failed",
    );
    if (clash) {
      return `a plugin named "${plugin.name}" is already registered`;
    }
    return undefined;
  }

  async #setUp(registration: Registration): Promise<void> {
    const { plugin } = registration;
    try {
      const teardown = await plugin.setup(this.#contextFor(plugin));
      // A plugin registered and then immediately stopped (stopAll ran while
      // its async setup was still in flight) must not be left "active" with
      // a teardown nobody will call.
      if (!this.#running) {
        registration.status = "stopped";
        if (typeof teardown === "function") {
          await teardown();
        }
        return;
      }
      registration.status = "active";
      if (typeof teardown === "function") {
        registration.teardown = teardown;
      }
    } catch (error) {
      // Quarantined, not retried: setup() failed partway, so whatever it
      // installed is in an unknown state and any teardown it might have
      // returned was never received. Running it again would only repeat
      // that.
      registration.status = "failed";
      registration.error = describeError(error);
      this.#loggerFor(plugin.name).error("setup failed — plugin disabled", error);
    }
  }

  #track(promise: Promise<void>): void {
    this.#pending.add(promise);
    // #setUp never rejects, so this only ever removes the entry.
    void promise.finally(() => {
      this.#pending.delete(promise);
    });
  }

  #contextFor(plugin: WevnaPlugin): PluginContext {
    const host = this.#host;
    const logger = this.#loggerFor(plugin.name);

    return {
      pluginName: plugin.name,
      publish: (event: PluginEvent): void => {
        // A plugin observes real work in the developer's application. If
        // publishing an observation could throw, a malformed event would
        // take down the operation being observed — so this contains its own
        // failures rather than propagating them to the call site.
        try {
          host.publish({
            id: randomUUID(),
            kind: event.kind,
            occurredAt: event.occurredAt ?? Date.now(),
            attributes: event.attributes,
            source: plugin.name,
            ...(event.correlation ? { correlation: event.correlation } : {}),
          });
        } catch (error) {
          logger.error("failed to publish an event", error);
        }
      },
      currentCorrelation: () => host.currentCorrelation(),
      startCorrelation: (fn) => host.startCorrelation(fn),
      runWithCorrelation: (correlation, fn) => host.runWithCorrelation(correlation, fn),
      logger,
    };
  }

  // console.warn/console.error, never console.log: ConsoleInstrumentation
  // patches console.log, so diagnostics logged there would be captured as
  // events in the developer's own stream.
  #loggerFor(pluginName: string): PluginLogger {
    const prefix = `[wevna] plugin "${pluginName}"`;
    return {
      warn: (message: string) => {
        console.warn(`${prefix}: ${message}`);
      },
      error: (message: string, error?: unknown) => {
        if (error === undefined) {
          console.error(`${prefix}: ${message}`);
          return;
        }
        console.error(`${prefix}: ${message}: ${describeError(error)}`);
      },
    };
  }
}
