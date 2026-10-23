// The storefront: a Node service that serves orders, and calls the Python pricing
// service for a quote on each one.
//
//   pnpm --filter @wevna/example-demo demo
//
// Dashboard: http://localhost:4123   Service: http://localhost:3001
import { createFetchPlugin } from "@wevna/plugin-fetch";
import { wevna, wevnaExpressErrorHandler } from "@wevna/sdk";
import express from "express";
import { Redis } from "ioredis";
import pg from "pg";

const PORT = Number(process.env.STOREFRONT_PORT ?? 3001);
const DASHBOARD_PORT = Number(process.env.STOREFRONT_DASHBOARD_PORT ?? 4123);
const PRICING_URL = process.env.PRICING_URL ?? "http://localhost:3002";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://demo:demo@localhost:5433/demo";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

// ---------------------------------------------------------------------------
// This is the whole Wevna setup.
// ---------------------------------------------------------------------------

wevna.use(createFetchPlugin());
await wevna.start({ port: DASHBOARD_PORT });

const pool = new pg.Pool({ connectionString: DATABASE_URL });
wevna.instrumentPg(pool);

// ioredis checks readiness with INFO on connect. Set REDIS_READY_CHECK=0 for a
// Redis-compatible server that does not implement it. Real Redis needs nothing.
const redis = new Redis(REDIS_URL, { enableReadyCheck: process.env.REDIS_READY_CHECK !== "0" });
wevna.instrumentRedis(redis);

// ---------------------------------------------------------------------------
// Below here is an ordinary Express app. Nothing is Wevna-aware.
// ---------------------------------------------------------------------------

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "storefront" });
});

app.get("/orders/:id", async (req, res) => {
  const id = Number(req.params.id);
  console.log(`fetching order ${id}`);

  const { rows: orders } = await pool.query(
    "select id, customer_id, total_cents from orders where id = $1",
    [id],
  );
  const order = orders[0];
  if (!order) {
    res.status(404).json({ error: "no such order" });
    return;
  }

  const { rows: customers } = await pool.query("select name, tier from customers where id = $1", [
    order.customer_id,
  ]);

  // A cache lookup, then a write on a miss.
  const cacheKey = `order:${id}:summary`;
  const cached = await redis.get(cacheKey);
  console.log(cached ? "summary cache hit" : "summary cache miss");

  // The N+1: the item ids first, then one query per item for its details,
  // instead of a single `where order_id = $1`. The Repeated Query insight in the
  // dashboard picks this up.
  const { rows: itemIds } = await pool.query(
    "select id from order_items where order_id = $1 order by id",
    [id],
  );
  const items = [];
  for (const { id: itemId } of itemIds) {
    const { rows } = await pool.query("select id, sku, qty from order_items where id = $1", [
      itemId,
    ]);
    items.push(rows[0]);
  }

  // Calls the Python service. That service calls back to /stock/:id below.
  const quote = await fetch(`${PRICING_URL}/quote/${id}?api_key=demo-secret`).then((r) => r.json());

  if (!cached) {
    await redis.set(cacheKey, JSON.stringify({ items: items.length }), "EX", 30);
  }
  res.json({ order, customer: customers[0], items, quote });
});

// Called by the Python service: one query and a cache read, for the other
// direction of the conversation.
app.get("/stock/:orderId", async (req, res) => {
  const orderId = Number(req.params.orderId);
  const warm = await redis.get(`stock:${orderId}`);
  const { rows } = await pool.query(
    "select sku, sum(qty)::int as needed from order_items where order_id = $1 group by sku",
    [orderId],
  );
  if (!warm) {
    await redis.set(`stock:${orderId}`, "checked", "EX", 15);
  }
  res.json({ orderId, lines: rows });
});

// The slow endpoint: a report whose query takes most of a second.
app.get("/reports/daily", async (_req, res) => {
  console.log("building the daily report");
  const { rows } = await pool.query(
    "select count(*)::int as orders, sum(total_cents)::int as revenue, pg_sleep(0.8) from orders",
  );
  await redis.set("report:daily:generatedAt", new Date().toISOString());
  res.json({ orders: rows[0].orders, revenue: rows[0].revenue });
});

// The failing request. A query succeeds, then the handler throws.
app.get("/boom", async (_req, res) => {
  await pool.query("select count(*) from orders");
  console.warn("about to fail");
  res.json(JSON.parse("{ this is not json"));
});

app.use(wevnaExpressErrorHandler);

const server = app.listen(PORT, () => {
  console.log(`storefront listening on http://localhost:${PORT}`);
  console.log(`dashboard at http://localhost:${DASHBOARD_PORT}`);
});

const shutdown = async (): Promise<void> => {
  server.close();
  await pool.end();
  redis.disconnect();
  await wevna.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
