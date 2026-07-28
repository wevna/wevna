import Fastify, { type FastifyInstance } from "fastify";

// TODO: Register WebSocket transport, event ingestion routes, and the
// dashboard static bundle once capture and the dashboard are implemented.
export function createServer(): FastifyInstance {
  const app = Fastify();

  app.get("/", async () => ({
    status: "running",
    product: "wevna",
  }));

  return app;
}
