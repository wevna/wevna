#!/usr/bin/env node
// Writes packages/protocol/fixtures/recordings/node-basic.jsonl using the real
// Node recorder (SessionRecorder, through the public wevna API). Run it after
// building @wevna/sdk:
//
//   pnpm --filter @wevna/sdk build && node scripts/generate-node-recording-fixture.mjs
//
// The file is committed. The Python SDK's tests read it with Python's own
// loader, which is how "Python can read what Node writes" stays a checked
// property rather than a belief. Timestamps and ids are whatever the run
// produced, so regenerate it only when the recording format changes.
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_API_VERSION, wevna } from "../packages/sdk/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../packages/protocol/fixtures/recordings/node-basic.jsonl");
await rm(out, { force: true });

const fixturePlugin = {
  name: "fixture",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  setup(context) {
    // Published once Wevna is running; one correlated request.
    context.startCorrelation(() => {
      context.publish({
        kind: "sql.query",
        attributes: { query: "select * from orders where id = $1", durationMs: 4.2, rows: 1 },
      });
      context.publish({
        kind: "redis.command",
        attributes: { command: "get", durationMs: 0.6 },
      });
      context.publish({
        kind: "http.request",
        attributes: {
          method: "GET",
          url: "/orders/42",
          route: "/orders/:id",
          statusCode: 200,
          durationMs: 12.5,
        },
      });
    });
    context.publish({ kind: "console.log", attributes: { message: "uncorrelated startup note" } });
    return undefined;
  },
};

wevna.use(fixturePlugin);
// Requested before start(), which Node queues: the promise settles once a
// session exists, so it must not be awaited before start() is called.
const recording = wevna.startRecording(out);
await wevna.start({ port: 0 });
await recording;
await wevna.pluginsSettled();
await wevna.stop();
console.log(`wrote ${path.relative(process.cwd(), out)}`);
