import type { Correlation } from "@wevna/protocol";

// The plugin API's own version, independent of both PROTOCOL_VERSION (the
// wire format) and the wevna package's release version. A plugin declares
// which api version it was built against and Wevna refuses to load one it
// cannot honour — see PluginManager.register().
//
// Versioned separately because the three change for different reasons: a
// new event kind is a protocol-compatible plugin addition, a bug fix is a
// package release with no API change, and only an actual change to
// PluginContext's shape or the plugin lifecycle is an api version bump.
export const PLUGIN_API_VERSION = 1;

// What a plugin emits. Deliberately narrower than CapturedEvent: `id` and
// `occurredAt` are stamped by Wevna, not the plugin, because every producer
// would otherwise repeat the same randomUUID()/Date.now() boilerplate and
// each repetition is a chance to get it subtly wrong (a plugin minting
// non-unique ids, or reading a clock at the wrong moment).
export interface PluginEvent {
  // Dotted, namespaced by subsystem: "mongodb.query", "prisma.operation",
  // "http.client". Wevna never parses this, but the dashboard groups by its
  // prefix (see event-kind-category.ts), so a consistent prefix is what
  // makes a plugin's events display sensibly alongside the built-ins.
  kind: string;
  attributes: Record<string, unknown>;
  // Almost always omit this: Wevna reads the clock when publish() is
  // called. Pass it only when the plugin genuinely knows better — e.g.
  // replaying an event whose real timestamp came from elsewhere.
  occurredAt?: number;
  // Almost always omit this too: the ambient correlation is attached
  // automatically, which is how every built-in producer gets request
  // correlation without knowing correlation exists. Pass it only to
  // attribute an event to a flow other than the calling one.
  correlation?: Correlation;
}

// Diagnostics for a plugin, namespaced with the plugin's own name so a
// developer can tell whose warning they're reading.
//
// Routed to console.warn/console.error rather than console.log on purpose:
// ConsoleInstrumentation patches console.log, so logging there would turn
// Wevna's own diagnostics into captured events — noise in the developer's
// event stream at best, and a feedback loop if a plugin ever warned in
// response to one.
export interface PluginLogger {
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

// Everything a plugin is given, and the entire surface it is allowed to
// depend on. Keeping this deliberately small is the point: it is the thing
// that must stay stable for community plugins to keep working, so anything
// not here (the EventBus, the server, the session, Runtime itself) is free
// to change without breaking anyone.
export interface PluginContext {
  // The plugin's own name, as a convenience for plugins that build their
  // own sub-loggers or annotate their events.
  readonly pluginName: string;

  // Publishes an event into the runtime's stream. Never throws, and never
  // needs guarding: before Wevna is running, or after it has stopped, the
  // event is dropped. A plugin observes a real operation in the
  // developer's application, and that operation must never fail — or even
  // notice — because Wevna wasn't listening.
  publish(event: PluginEvent): void;

  // The correlation the calling async flow belongs to, if any. Plugins
  // rarely need this: publish() already attaches it.
  currentCorrelation(): Correlation | undefined;

  // Opens a *new* correlation scope for everything `fn` does, including
  // async continuations. This is the extension point that lets a future
  // queue/worker plugin (BullMQ, Kafka) group a job's events the way
  // HttpInstrumentation groups a request's — the correlation machinery was
  // never HTTP-specific, it just had no other caller.
  startCorrelation<T>(fn: () => T): T;

  // Re-enters an existing correlation — for a plugin that carries a
  // correlation id across a boundary Wevna cannot follow on its own (a
  // queue payload, a message header) and wants the consumer side to join
  // the producer's flow.
  runWithCorrelation<T>(correlation: Correlation, fn: () => T): T;

  readonly logger: PluginLogger;
}

// Returned from setup() to undo whatever the plugin installed. Optional:
// a plugin with nothing to unwind (or nothing it can unwind) simply
// returns nothing.
export type PluginTeardown = () => void | Promise<void>;

// setup()'s return type. `undefined` rather than `void` is what makes a
// setup body with no return statement legal while still describing "either
// a teardown or nothing" precisely — `void` in a union says the same thing
// less clearly, which is what noConfusingVoidType objects to.
export type PluginSetupResult = PluginTeardown | undefined;

export interface WevnaPlugin {
  // Unique per runtime. Conventionally the npm package name
  // ("@wevna/plugin-mongodb", "wevna-plugin-acme") so that a collision
  // means two copies of the same plugin, which is always a mistake worth
  // reporting rather than silently tolerating.
  readonly name: string;
  // The plugin's own release version. Wevna never interprets this; it
  // exists so `wevna.plugins` is useful in a bug report.
  readonly version: string;
  // Which PLUGIN_API_VERSION this plugin was written against.
  readonly apiVersion: number;
  // Optional, declarative: the event kinds this plugin can emit. Wevna
  // does not enforce it — a plugin that declares nothing still works, and
  // one that publishes an undeclared kind is not blocked. It exists so the
  // set of kinds a runtime can produce is answerable *before* any event has
  // been produced, which is what makes documentation, a dashboard filter
  // list, or a "why am I seeing no mongodb events" diagnostic possible.
  readonly eventKinds?: readonly string[];

  // Called once, when the runtime starts (or immediately, if the runtime
  // is already running when the plugin is registered). Install hooks,
  // patch clients, subscribe to driver events here.
  //
  // Throwing is contained: the plugin is marked "failed" and skipped from
  // then on, while the runtime and the developer's application carry on.
  setup(context: PluginContext): PluginSetupResult | Promise<PluginSetupResult>;
}

export type PluginStatus =
  // Registered, but the runtime has not started yet, so setup() has not run.
  | "registered"
  // setup() completed; the plugin is live.
  | "active"
  // setup() threw or rejected. Quarantined: never set up again, never torn
  // down (there is no teardown to trust from a setup that did not finish).
  | "failed"
  // Was active, and its teardown has run.
  | "stopped";

// The read-only view of a plugin's registration, for `wevna.plugins`. A
// snapshot, not a live handle: it deliberately exposes no way to reach the
// plugin object or its context, so reading this can never become a second,
// undocumented way to drive a plugin.
export interface PluginDescriptor {
  name: string;
  version: string;
  apiVersion: number;
  eventKinds: readonly string[];
  status: PluginStatus;
  // Present only for a "failed" plugin: the message from whatever setup()
  // threw, so a developer can see why without turning on any extra logging.
  error?: string;
}
