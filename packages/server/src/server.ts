import { Readable } from "node:stream";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { registerDashboard } from "./dashboard.js";
import type { OfflineSessionSource } from "./offline-session-source.js";
import { type EventSource, WebSocketTransport } from "./websocket-transport.js";

export interface CreateServerOptions {
  dashboardDir?: string;
  eventSource?: EventSource;
  // When present, the dashboard is being served against a recording
  // instead of a live runtime — mutually exclusive with eventSource in
  // practice (a caller wires up one or the other), though nothing here
  // enforces that; each is simply registered independently if given.
  session?: OfflineSessionSource;
}

export async function createServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify();
  const session = options.session;

  app.get("/health", async () => ({
    status: "running",
    product: "wevna",
  }));

  // Always registered, in both live and offline modes — this is the one
  // thing the dashboard needs to ask before it knows which event source to
  // use. Not gated behind session/eventSource like the routes below: a
  // client should always be able to ask "what mode is this?", even before
  // deciding whether to open /ws or fetch /api/session/events.
  app.get("/api/session", async () => {
    if (session) {
      return { mode: "recording" as const, metadata: session.getMetadata() };
    }
    return { mode: "live" as const };
  });

  if (session) {
    // A recording is finite and already fully known, unlike a live
    // stream — there's nothing to "subscribe" to, so this is a plain
    // request/response fetch rather than a WebSocket. The body is still one
    // JSON document, `{"events":[...]}`, but it is written as the loader
    // yields rather than built up first, so the server never holds the whole
    // recording (or its serialized form) in memory at once.
    app.get("/api/session/events", async (_request, reply) => {
      return reply.type("application/json").send(Readable.from(streamEventsJson(session)));
    });
  }

  if (options.eventSource) {
    await new WebSocketTransport().register(app, options.eventSource);
  }

  // Registered after /health (and the websocket route) so the dashboard's
  // static assets never shadow them.
  await registerDashboard(app, options.dashboardDir);

  return app;
}

async function* streamEventsJson(session: OfflineSessionSource): AsyncGenerator<string> {
  yield '{"events":[';
  let first = true;
  for await (const event of session.getEvents()) {
    yield (first ? "" : ",") + JSON.stringify(event satisfies Envelope<CapturedEvent>);
    first = false;
  }
  yield "]}";
}
