#!/usr/bin/env node
// Type-checks (default), lints (--lint) or byte-compiles (--compile) the Python service, using the Python
// SDK's own virtualenv and its mypy and ruff settings. The service is a Python
// file inside a JavaScript package, so turbo's check and lint tasks run this
// to cover it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const service = path.resolve(here, "../python-service");
const sdk = path.resolve(here, "../../../python/wevna");
const runner = path.join(sdk, "scripts/run.sh");
const config = path.join(sdk, "pyproject.toml");

function run(args) {
  const result = spawnSync("bash", [runner, ...args], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.argv.includes("--compile")) {
  // The cheapest proof the service at least parses: byte-compile it.
  run(["python", "-m", "py_compile", path.join(service, "app.py")]);
} else if (process.argv.includes("--lint")) {
  run(["ruff", "check", "--config", config, service]);
  run(["ruff", "format", "--check", "--config", config, service]);
} else {
  run(["mypy", "--config-file", config, service]);
}
