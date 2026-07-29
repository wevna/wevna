import Fastify, { type FastifyInstance } from "fastify";
import { registerDashboard } from "./dashboard.js";
import { type EventSource, WebSocketTransport } from "./websocket-transport.js";

export interface CreateServerOptions {
  dashboardDir?: string;
  eventSource?: EventSource;
}

export async function createServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify();

  app.get("/health", async () => ({
    status: "running",
    product: "wevna",
  }));

  if (options.eventSource) {
    await new WebSocketTransport().register(app, options.eventSource);
  }

  // Registered after /health (and the websocket route) so the dashboard's
  // static assets never shadow them.
  registerDashboard(app, options.dashboardDir);

  return app;
}
