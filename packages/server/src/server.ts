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
    // request/response fetch rather than a WebSocket. Drains
    // session.getEvents() (itself typically backed by a streaming
    // SessionLoader — see @wevna/sdk) into one response; see that
    // package's own docs for why the *loader* stays streaming even though
    // this endpoint's response is a single JSON payload.
    app.get("/api/session/events", async () => {
      const events: Envelope<CapturedEvent>[] = [];
      for await (const event of session.getEvents()) {
        events.push(event);
      }
      return { events };
    });
  }

  if (options.eventSource) {
    await new WebSocketTransport().register(app, options.eventSource);
  }

  // Registered after /health (and the websocket route) so the dashboard's
  // static assets never shadow them.
  registerDashboard(app, options.dashboardDir);

  return app;
}
