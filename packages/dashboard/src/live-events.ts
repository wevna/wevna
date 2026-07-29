import type { CapturedEvent, Envelope } from "@wevna/protocol";
import type { EventStore } from "./event-store.ts";

// Networking only: opens a connection to Wevna's WebSocket transport and
// appends every received envelope into the given store, unchanged. Knows
// nothing about React or rendering — that lives in useLiveEvents.
export function connectToLiveEvents(store: EventStore): () => void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  const handleMessage = (message: MessageEvent<string>): void => {
    const envelope = JSON.parse(message.data) as Envelope<CapturedEvent>;
    store.append(envelope);
  };

  socket.addEventListener("message", handleMessage);

  return () => {
    socket.removeEventListener("message", handleMessage);
    socket.close();
  };
}
