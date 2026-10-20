import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { StartedServer } from "./start.js";
import { startServer } from "./start.js";

// Real sockets, real handshakes. The unit tests in server.test.ts cover the
// guard with injected requests; this is the check that a *browser-shaped*
// connection — an Origin header on a real upgrade — is actually refused, which
// is the attack, and that the event stream a hostile page would have wanted
// never reaches it.

interface Probe {
  closeCode: number;
  messages: string[];
}

function connect(url: string, origin: string | undefined, holdMs = 400): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const socket = new WebSocket(url, origin ? { headers: { Origin: origin } } : {});
    socket.on("message", (data) => messages.push(String(data)));
    socket.on("close", (closeCode) => resolve({ closeCode, messages }));
    socket.on("error", reject);
    setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000);
      }
    }, holdMs);
  });
}

describe("cross-site access to a running server", () => {
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.stop();
    started = undefined;
  });

  async function startWithSource() {
    let emit: ((payload: string) => void) | undefined;
    started = await startServer({
      port: 0,
      eventSource: {
        subscribe: (listener) => {
          emit = (kind) =>
            listener({
              version: 1,
              sessionId: "s",
              sequence: 1,
              payload: { id: "e", kind, occurredAt: Date.now(), attributes: { sql: "secret" } },
            });
          return () => {};
        },
      },
    });
    return { wsUrl: `ws://localhost:${started.port}/ws`, publish: () => emit?.("sql.query") };
  }

  it("refuses a WebSocket from a foreign Origin and leaks nothing to it", async () => {
    const { wsUrl, publish } = await startWithSource();
    const pending = connect(wsUrl, "https://evil.example.com");
    setTimeout(publish, 150);

    const probe = await pending;

    expect(probe.closeCode).toBe(1008);
    expect(probe.messages).toEqual([]);
  });

  it("still streams to the dashboard's own origin and to a client with no Origin", async () => {
    const { wsUrl, publish } = await startWithSource();
    const local = connect(wsUrl, `http://localhost:${started?.port}`);
    const bare = connect(wsUrl, undefined);
    setTimeout(publish, 150);

    const [fromDashboard, fromScript] = await Promise.all([local, bare]);

    expect(fromDashboard.messages).toHaveLength(1);
    expect(fromScript.messages).toHaveLength(1);
  });

  it("refuses an HTTP request that arrives under a rebound hostname", async () => {
    await startWithSource();

    // node:http, not fetch: fetch silently ignores a Host override. This is the
    // request a rebinding page's browser sends once its own name resolves here.
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: started?.port,
          path: "/health",
          headers: { host: "evil.example.com" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });

    expect(status).toBe(403);
  });
});
