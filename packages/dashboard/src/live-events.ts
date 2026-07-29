import type { CapturedEvent, Envelope } from "@wevna/protocol";

// Proves end-to-end connectivity through Wevna's WebSocket transport: opens
// a connection and logs every received protocol envelope to the browser
// console, unchanged. No event viewer, filtering, or state yet — this only
// establishes that messages arrive.
export function connectToLiveEvents(): void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  socket.addEventListener("message", (message) => {
    const envelope = JSON.parse(message.data as string) as Envelope<CapturedEvent>;
    console.log("[wevna]", envelope);
  });
}
