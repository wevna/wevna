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
  // When present, POST /api/ingest accepts events from processes that are not
  // this one — an SDK for another language. The host decides what to do with
  // them (Runtime stamps session and sequence); the server only parses the
  // request and enforces its shape.
  ingest?: (events: IngestedEvent[]) => void;
}

// What a foreign SDK may send. Deliberately a subset of CapturedEvent: the id
// and the envelope (version, session, sequence) are the receiving runtime's
// to assign, so a client cannot forge ordering or collide ids.
export interface IngestedEvent {
  kind: string;
  occurredAt?: number;
  attributes: Record<string, unknown>;
  correlation?: { id: string };
  source?: string;
}

export const INGEST_ROUTE = "/api/ingest";
export const MAX_INGEST_BATCH = 1000;
// Fastify's default is 1 MiB, which a batch of ordinary events overruns: 500
// SQL statements of a few KiB each is already 2 MiB, and one rejected request
// loses the whole batch.
export const MAX_INGEST_BODY_BYTES = 16 * 1024 * 1024;

function parseIngestBody(body: unknown): IngestedEvent[] | string {
  if (!body || typeof body !== "object" || !Array.isArray((body as { events?: unknown }).events)) {
    return 'expected {"events": [...]}';
  }
  const raw = (body as { events: unknown[] }).events;
  if (raw.length > MAX_INGEST_BATCH) {
    return `at most ${MAX_INGEST_BATCH} events per request`;
  }

  const events: IngestedEvent[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object") {
      return `events[${index}] is not an object`;
    }
    const { kind, occurredAt, attributes, correlation, source } = item as Record<string, unknown>;
    if (typeof kind !== "string" || kind.length === 0) {
      return `events[${index}].kind must be a non-empty string`;
    }
    if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
      return `events[${index}].attributes must be an object`;
    }
    if (
      occurredAt !== undefined &&
      (typeof occurredAt !== "number" || !Number.isFinite(occurredAt))
    ) {
      return `events[${index}].occurredAt must be a number`;
    }
    const correlationId =
      correlation && typeof correlation === "object"
        ? (correlation as { id?: unknown }).id
        : undefined;
    if (correlation !== undefined && typeof correlationId !== "string") {
      return `events[${index}].correlation.id must be a string`;
    }
    events.push({
      kind,
      attributes: attributes as Record<string, unknown>,
      ...(occurredAt !== undefined ? { occurredAt: occurredAt as number } : {}),
      ...(typeof correlationId === "string" ? { correlation: { id: correlationId } } : {}),
      ...(typeof source === "string" ? { source } : {}),
    });
  }
  return events;
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

  const ingest = options.ingest;
  if (ingest) {
    // Only application/json is accepted (415 otherwise). That is the whole
    // cross-site defence: a web page can POST
    // text/plain or a form to localhost without a CORS preflight, but cannot
    // send application/json without one, and this server answers no
    // preflight. Without it, any site you visit could inject events into the
    // dashboard.
    app.post(INGEST_ROUTE, { bodyLimit: MAX_INGEST_BODY_BYTES }, async (request, reply) => {
      // Checked explicitly: Fastify also parses text/plain, and that is
      // precisely the content type a cross-site page can send without a
      // preflight.
      if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
        return reply.code(415).send({ error: "content-type must be application/json" });
      }
      const parsed = parseIngestBody(request.body);
      if (typeof parsed === "string") {
        return reply.code(400).send({ error: parsed });
      }
      ingest(parsed);
      return reply.code(202).send({ accepted: parsed.length });
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
