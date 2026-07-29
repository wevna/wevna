import type { FastifyInstance } from "fastify";
import { createServer } from "./server.js";
import type { EventSource } from "./websocket-transport.js";

export const DEFAULT_PORT = 4123;
export const DEFAULT_HOST = "localhost";

export interface StartServerOptions {
  port?: number;
  host?: string;
  dashboardDir?: string;
  eventSource?: EventSource;
}

export interface StartedServer {
  app: FastifyInstance;
  port: number;
  host: string;
  url: string;
  stop: () => Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const app = await createServer({
    dashboardDir: options.dashboardDir,
    eventSource: options.eventSource,
  });

  try {
    await app.listen({ port, host });
  } catch (error) {
    await app.close();
    throw toStartError(error, port);
  }

  const boundPort = getBoundPort(app) ?? port;
  const url = `http://${host}:${boundPort}`;

  return {
    app,
    port: boundPort,
    host,
    url,
    stop: () => app.close(),
  };
}

function getBoundPort(app: FastifyInstance): number | undefined {
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    return undefined;
  }
  return address.port;
}

function toStartError(error: unknown, port: number): Error {
  if (isErrnoException(error) && error.code === "EADDRINUSE") {
    return new Error(
      `Wevna could not start: port ${port} is already in use. ` +
        "Stop the process using it, or start Wevna with a different port.",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
