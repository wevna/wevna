import {
  PLUGIN_API_VERSION,
  type PluginContext,
  type PluginSetupResult,
  type WevnaPlugin,
} from "@wevna/sdk";

// The subset of the driver's command-monitoring events this reads. Structural
// so a real MongoClient satisfies it without this package depending on the
// `mongodb` driver (or pinning a version of it).
export interface MongoCommandStartedEvent {
  requestId: number;
  commandName: string;
  databaseName?: string;
  // Only ever read for the collection name (the first key's value). The rest
  // of the command is where filters, documents and update values live.
  command?: Record<string, unknown>;
}

export interface MongoCommandFinishedEvent {
  requestId: number;
  commandName?: string;
  // Milliseconds, as reported by the driver.
  duration: number;
  failure?: unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: matches EventEmitter's own listener type, which a real MongoClient (an EventEmitter) must be assignable to.
type Listener = (...args: any[]) => void;

export interface MongoClientLike {
  on(event: string, listener: Listener): unknown;
  off?(event: string, listener: Listener): unknown;
  removeListener?(event: string, listener: Listener): unknown;
}

export interface MongoDbPluginOptions {
  // Additional command names to leave out. The driver's own housekeeping is
  // always left out — see DEFAULT_IGNORED_COMMANDS.
  ignoreCommands?: readonly string[];
}

export interface MongoDbPlugin extends WevnaPlugin {
  // The client must be constructed with `monitorCommands: true`; the driver
  // emits no command events otherwise, and nothing here can turn that on
  // after the fact.
  instrument(client: MongoClientLike): void;
}

// Connection handshakes, heartbeats and session bookkeeping. A request that
// "ran 40 commands" because the driver pinged its servers is noise that
// would drown out the operations the application actually performed.
const DEFAULT_IGNORED_COMMANDS: ReadonlySet<string> = new Set([
  "hello",
  "isMaster",
  "ismaster",
  "ping",
  "saslStart",
  "saslContinue",
  "endSessions",
  "buildInfo",
  "getLastError",
  "killCursors",
]);

function targetOf(event: MongoCommandStartedEvent): string | undefined {
  const value = event.command?.[event.commandName];
  // `find: "users"` carries the collection; admin commands carry `1`.
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// MongoDB instrumentation through the driver's own command monitoring rather
// than by patching Collection methods: it sees every command from every
// collection handle (including ones the application creates later), needs no
// knowledge of which helper called which command, and wrapping nothing means
// there is nothing to un-wrap — teardown just removes two listeners.
//
// Records the operation (`find`, `insert`, `aggregate`...), the collection and
// database it ran against, how long it took, and the failure if there was
// one. Never records the command document: filters, inserted documents and
// update operators are arbitrary user data, the same reasoning that keeps SQL
// parameter values and Redis arguments out of their events.
export function createMongoDbPlugin(options: MongoDbPluginOptions = {}): MongoDbPlugin {
  const ignored = new Set([...DEFAULT_IGNORED_COMMANDS, ...(options.ignoreCommands ?? [])]);
  const clients = new Set<MongoClientLike>();
  let context: PluginContext | undefined;
  let detach: Array<() => void> = [];

  // Command lifecycle events fire from socket callbacks, where the caller's
  // async context is not reliably active. The correlation is therefore read
  // at commandStarted — emitted synchronously on the caller's own path — and
  // carried to the finish event by request id.
  const inFlight = new Map<
    number,
    {
      operation: string;
      target: string | undefined;
      database: string | undefined;
      correlation: ReturnType<PluginContext["currentCorrelation"]>;
    }
  >();

  function attach(client: MongoClientLike): void {
    const onStarted = (event: MongoCommandStartedEvent): void => {
      if (!context || ignored.has(event.commandName)) {
        return;
      }
      inFlight.set(event.requestId, {
        operation: event.commandName,
        target: targetOf(event),
        database: event.databaseName,
        correlation: context.currentCorrelation(),
      });
    };

    const finish = (event: MongoCommandFinishedEvent, failed: boolean): void => {
      const started = inFlight.get(event.requestId);
      if (!started) {
        return;
      }
      inFlight.delete(event.requestId);
      context?.publish({
        kind: "mongodb.command",
        ...(started.correlation ? { correlation: started.correlation } : {}),
        attributes: {
          operation: started.operation,
          ...(started.target ? { target: started.target } : {}),
          ...(started.database ? { database: started.database } : {}),
          durationMs: event.duration,
          ...(failed ? { error: describeFailure(event.failure) } : {}),
        },
      });
    };

    const onSucceeded = (event: MongoCommandFinishedEvent): void => finish(event, false);
    const onFailed = (event: MongoCommandFinishedEvent): void => finish(event, true);

    client.on("commandStarted", onStarted);
    client.on("commandSucceeded", onSucceeded);
    client.on("commandFailed", onFailed);

    detach.push(() => {
      const remove = (name: string, listener: Listener): void => {
        (client.off ?? client.removeListener)?.call(client, name, listener);
      };
      remove("commandStarted", onStarted);
      remove("commandSucceeded", onSucceeded);
      remove("commandFailed", onFailed);
    });
  }

  return {
    name: "@wevna/plugin-mongodb",
    version: "0.1.0",
    apiVersion: PLUGIN_API_VERSION,
    eventKinds: ["mongodb.command"],

    setup(ctx: PluginContext): PluginSetupResult {
      context = ctx;
      // Clients handed over before Wevna started.
      for (const client of clients) {
        attach(client);
      }

      return () => {
        for (const remove of detach) {
          remove();
        }
        detach = [];
        inFlight.clear();
        context = undefined;
      };
    },

    instrument(client: MongoClientLike): void {
      if (clients.has(client)) {
        return;
      }
      clients.add(client);
      if (context) {
        attach(client);
      }
    },
  };
}

// The driver's failure is an Error (MongoServerError carries a numeric
// `code` and `codeName`). The code name is stable and safe to show; the
// message can quote the offending document in a duplicate-key error.
function describeFailure(failure: unknown): string {
  if (failure && typeof failure === "object") {
    const { codeName } = failure as { codeName?: unknown };
    if (typeof codeName === "string") {
      return codeName;
    }
    const { name } = failure as { name?: unknown };
    if (typeof name === "string") {
      return name;
    }
  }
  return "CommandFailed";
}
