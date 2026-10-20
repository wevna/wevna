import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CapturedEvent, Envelope } from "@wevna/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { Runtime } from "./runtime.js";

// The contract between the two SDKs, tested by running them against each
// other: a real Python process, using the real Python package, sends a request
// through the real ingest endpoint of a real Runtime. Neither side's unit tests
// can catch a disagreement about the wire format; this can.
//
// Skipped when python3 is not installed, so the Node suite never depends on it.
const pythonSource = fileURLToPath(new URL("../../../python/src", import.meta.url));
const hasPython = spawnSync("python3", ["--version"]).status === 0;

const SCRIPT = `
import sqlite3, sys, wevna
wevna.start(sys.argv[1], instrument=False)
conn = wevna.instrument_connection(sqlite3.connect(":memory:"))

def app(environ, start_response):
    conn.execute("select 1")
    wevna.emit("redis.command", {"command": "get", "durationMs": 1.5})
    wevna.set_route("/orders/<int:order_id>")
    start_response("200 OK", [])
    return [b"ok"]

wrapped = wevna.wsgi.WevnaWSGIMiddleware(app)
environ = {"REQUEST_METHOD": "GET", "PATH_INFO": "/orders/7", "QUERY_STRING": "page=2"}
result = wrapped(environ, lambda *a: None)
b"".join(result)
result.close()
wevna.stop()  # flushes
`;

function runPython(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", SCRIPT, url], {
      env: { ...process.env, PYTHONPATH: pythonSource },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
}

describe.skipIf(!hasPython)("Python SDK feeding a Node runtime", () => {
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.stop();
  });

  it("delivers a correlated request, query and command that the intelligence layer can assemble", async () => {
    runtime = new Runtime();
    await runtime.start({ port: 0, ingest: true });
    const received: Envelope<CapturedEvent>[] = [];
    runtime.eventBus.subscribe((event) => {
      if (event.payload.source === "wevna-python") {
        received.push(event);
      }
    });

    const exitCode = await runPython(runtime.url as string);

    expect(exitCode).toBe(0);
    expect(received.map((e) => e.payload.kind).sort()).toEqual([
      "http.request",
      "redis.command",
      "sql.query",
    ]);

    // One request: every event carries the same correlation id.
    const ids = new Set(received.map((e) => e.payload.correlation?.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toEqual(expect.any(String));

    // The runtime, not the sender, owns identity and ordering.
    expect(new Set(received.map((e) => e.sessionId))).toEqual(new Set([runtime.session?.id]));
    expect(received.map((e) => e.sequence)).toEqual(
      [...received.map((e) => e.sequence)].sort((a, b) => a - b),
    );

    const request = received.find((e) => e.payload.kind === "http.request")?.payload.attributes;
    expect(request).toMatchObject({
      method: "GET",
      url: "/orders/7?page=2",
      route: "/orders/<int:order_id>",
      statusCode: 200,
    });
    expect(request?.durationMs).toEqual(expect.any(Number));

    const sql = received.find((e) => e.payload.kind === "sql.query")?.payload.attributes;
    expect(sql).toMatchObject({ query: "select 1" });
  });

  it("does not hang or fail the Python process when the dashboard is not running", async () => {
    const exitCode = await runPython("http://127.0.0.1:1");

    expect(exitCode).toBe(0);
  });
});
