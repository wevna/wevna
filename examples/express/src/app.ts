import { createFetchPlugin } from "@wevna/plugin-fetch";
import { wevna, wevnaExpressErrorHandler } from "@wevna/sdk";
import express from "express";
import { createPool, createRedis, ORDER_ITEMS } from "./fake-clients.js";

const APP_PORT = 3000;
const UPSTREAM_PORT = 3001;

// A local stand-in for a third-party API, so the fetch plugin has something
// real to call without this example needing network access.
const upstream = express();
upstream.get("/rates/:currency", async (req, res) => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  res.json({ currency: req.params.currency, rate: 1.0 });
});
const upstreamServer = upstream.listen(UPSTREAM_PORT);

// ---------------------------------------------------------------------------
// This is the whole Wevna setup.
// ---------------------------------------------------------------------------

wevna.use(createFetchPlugin());
await wevna.start();

const pool = createPool();
wevna.instrumentPg(pool);

const redis = createRedis();
wevna.instrumentRedis(redis);

// ---------------------------------------------------------------------------
// Below here is just an ordinary Express app. Nothing is Wevna-aware.
// ---------------------------------------------------------------------------

const app = express();

app.get("/orders/:id", async (req, res) => {
  const { id } = req.params;
  console.log(`fetching order ${id}`);

  const { rows: orders } = await pool.query<{ id: number; customer_id: number }>(
    'select * from "Orders" where "id" = $1',
    [id],
  );
  const order = orders[0];

  const tier = await redis.get("session:abc");
  console.log(`customer tier: ${tier}`);

  await pool.query('select * from "Customers" where "id" = $1', [order?.customer_id]);

  // The N+1: one query per item, instead of a single `where "orderId" in (...)`.
  // Watch the Repeated Query insight pick this up in the dashboard.
  const items = [];
  for (const item of ORDER_ITEMS) {
    const { rows } = await pool.query('select * from "OrderItems" where "orderId" = $1', [item.id]);
    items.push(rows[0]);
  }

  // An outgoing call, captured by @wevna/plugin-fetch and correlated to this
  // request. The api_key value is redacted before it reaches the dashboard.
  const rates = await fetch(`http://localhost:${UPSTREAM_PORT}/rates/usd?api_key=secret123`).then(
    (response) => response.json(),
  );

  await redis.set(`order:${id}:cached`, "1");
  console.log(`order ${id} assembled with ${items.length} items`);

  res.json({ order, items, rates, tier });
});

app.get("/health", (_req, res) => {
  console.log("health check");
  res.json({ ok: true });
});

// Throws on purpose, so you can see an exception attached to the request that
// produced it. wevnaExpressErrorHandler is what captures it.
app.get("/boom", () => {
  throw new Error("Something broke while pricing the order");
});

app.use(wevnaExpressErrorHandler);

const server = app.listen(APP_PORT, () => {
  console.log("");
  console.log(`  Demo app     http://localhost:${APP_PORT}`);
  console.log(`  Dashboard    http://localhost:4123`);
  console.log("");
  console.log("  Try these, then watch the dashboard:");
  console.log(`    curl http://localhost:${APP_PORT}/orders/42   # the interesting one`);
  console.log(`    curl http://localhost:${APP_PORT}/health`);
  console.log(`    curl http://localhost:${APP_PORT}/boom        # throws on purpose`);
  console.log("");
});

const shutdown = async () => {
  server.close();
  upstreamServer.close();
  await wevna.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
