#!/usr/bin/env node
// Validates docker-compose.yml with `docker compose config`, which parses and
// resolves the file without starting anything or needing a running daemon. Skipped
// with a message where Docker is not installed, so the check never fails a machine
// that simply cannot run the demo.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const demoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status !== 0) {
  console.log("docker compose not found: skipping the compose file check.");
  process.exit(0);
}
const result = spawnSync("docker", ["compose", "config", "--quiet"], {
  cwd: demoDir,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
