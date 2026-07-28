import Fastify, { type FastifyInstance } from "fastify";
import { registerDashboard } from "./dashboard.js";

export interface CreateServerOptions {
  dashboardDir?: string;
}

// TODO: Register WebSocket transport and event ingestion routes once
// capture is implemented.
export function createServer(options: CreateServerOptions = {}): FastifyInstance {
  const app = Fastify();

  app.get("/health", async () => ({
    status: "running",
    product: "wevna",
  }));

  // Registered after /health so the dashboard's static assets never shadow
  // it.
  registerDashboard(app, options.dashboardDir);

  return app;
}
