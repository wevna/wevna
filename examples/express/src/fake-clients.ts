// Stand-ins for pg.Pool and ioredis, so this example runs with nothing
// installed and no containers to start.
//
// They are not mocks of Wevna. Wevna's instrumentation interfaces are
// structural on purpose — PgQueryable needs only `query()`, and
// RedisSendCommandLike only `sendCommand()` — precisely so a real client
// satisfies them without Wevna depending on `pg` or `ioredis`. These objects
// satisfy the same interfaces, so they travel the identical code path a real
// Pool or Redis client does. Only the storage is fake; every event you see in
// the dashboard was produced by the real instrumentation.
//
// Swap `createPool()` for `new Pool()` and `createRedis()` for `new Redis()`
// and nothing else in app.ts changes.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ORDERS = [{ id: 42, customer_id: 7, total_cents: 8400, status: "shipped" }];

export const ORDER_ITEMS = [
  { id: 1, order_id: 42, sku: "WV-KEYBOARD-87", qty: 1, price_cents: 6900 },
  { id: 2, order_id: 42, sku: "WV-CABLE-USBC", qty: 2, price_cents: 500 },
  { id: 3, order_id: 42, sku: "WV-STICKER-PK", qty: 1, price_cents: 300 },
  { id: 4, order_id: 42, sku: "WV-MAT-DESK", qty: 1, price_cents: 700 },
];

export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

export function createPool() {
  return {
    // Generic like pg's own query(), so call sites read the way they would
    // against a real Pool.
    async query<R = Record<string, unknown>>(
      textOrConfig: unknown,
      _values?: unknown,
    ): Promise<QueryResult<R>> {
      const text =
        typeof textOrConfig === "string"
          ? textOrConfig
          : ((textOrConfig as { text?: string })?.text ?? "");

      const result = <T>(rows: T[]): QueryResult<R> => ({
        rows: rows as unknown as R[],
        rowCount: rows.length,
      });

      if (text.includes('"Orders"')) {
        await sleep(3);
        return result(ORDERS);
      }
      if (text.includes('"OrderItems"')) {
        // Deliberately slow, and called once per item in app.ts: this is the
        // N+1 the Repeated Query insight exists to surface.
        await sleep(38);
        return result([ORDER_ITEMS[0]]);
      }
      if (text.includes('"Customers"')) {
        await sleep(4);
        return result([{ id: 7, name: "Ada Lovelace", tier: "gold" }]);
      }
      await sleep(2);
      return result([]);
    },
  };
}

// ioredis routes every convenience method (get, set, ...) through
// sendCommand(command), where `command` carries a `.name` and a `.promise`
// that settles independently of what sendCommand itself returns. Wrapping
// sendCommand is therefore one choke point covering all of them, and this
// reproduces that shape.
export function createRedis() {
  const store = new Map<string, string>([["session:abc", "gold"]]);

  const run = async (name: string, args: string[]): Promise<string | null> => {
    await sleep(name === "get" ? 2 : 3);
    if (name === "get") return store.get(args[0] as string) ?? null;
    if (name === "set") {
      store.set(args[0] as string, args[1] as string);
      return "OK";
    }
    return null;
  };

  const client = {
    sendCommand(command: { name?: unknown; promise?: Promise<unknown> }) {
      return command.promise;
    },
    async get(key: string) {
      const command = { name: "get", promise: run("get", [key]) };
      client.sendCommand(command);
      return command.promise;
    },
    async set(key: string, value: string) {
      const command = { name: "set", promise: run("set", [key, value]) };
      client.sendCommand(command);
      return command.promise;
    },
  };

  return client;
}
