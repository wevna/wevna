#!/usr/bin/env node
import { parseArgs, USAGE } from "./cli-args.js";
import { wevna } from "./index.js";

// `npx @wevna/sdk` — the dashboard on its own, with no Node app attached.
// It exists for backends written in other languages: they cannot call
// wevna.start(), so they send their events to this process instead (see the
// Python SDK). Ingest is on here because accepting those events is the whole
// job.

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(USAGE);
    return;
  }

  await wevna.start({ ...parsed, ingest: true });

  const shutdown = (): void => {
    void wevna.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`wevna: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
