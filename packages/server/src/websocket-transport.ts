import websocketPlugin from "@fastify/websocket";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

export type EventListener = (event: Envelope<CapturedEvent>) => void;

// Structural on purpose: @wevna/server must not depend on @wevna/sdk (sdk
// already depends on server), so this describes only the one method the
// transport needs rather than importing Runtime's EventBus class. EventBus
// satisfies this shape without either package importing the other.
export interface EventSource {
  subscribe(listener: EventListener): () => void;
}

export const WEBSOCKET_ROUTE = "/ws";

// Wevna's first external transport. It subscribes to a protocol EventSource
// and broadcasts every envelope it receives, unchanged, to every connected
// dashboard client — it never produces events and has no instrumentation
// logic of its own. Owned by the server: register() wires it into a Fastify
// app's own lifecycle, so it tears down automatically when that app closes.
export class WebSocketTransport {
  #clients = new Set<WebSocket>();

  async register(app: FastifyInstance, eventSource: EventSource): Promise<void> {
    await app.register(websocketPlugin);

    app.get(WEBSOCKET_ROUTE, { websocket: true }, (socket: WebSocket) => {
      this.#clients.add(socket);
      socket.on("close", () => {
        this.#clients.delete(socket);
      });
    });

    const unsubscribe = eventSource.subscribe((event) => {
      this.#broadcast(event);
    });

    app.addHook("onClose", async () => {
      unsubscribe();

      for (const client of this.#clients) {
        client.close();
      }
      this.#clients.clear();
    });
  }

  #broadcast(event: Envelope<CapturedEvent>): void {
    const message = JSON.stringify(event);
    for (const client of this.#clients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }
  }
}
