#!/usr/bin/env node
// One command to run the whole demo:
//
//   pnpm --filter @wevna/example-demo demo
//
// 1. starts Postgres and Redis with docker compose (skipped with NO_DOCKER=1, in
//    which case DATABASE_URL, PRICING_DATABASE_URL and REDIS_URL must point at
//    servers you already have),
// 2. creates a Python virtualenv on first run and installs the Python SDK into it,
// 3. starts the Node storefront and the Python pricing service,
// 4. waits until both answer, then prints where to look.
//
// Ctrl-C stops both services. The databases keep running; stop them with
// `pnpm --filter @wevna/example-demo demo:down`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const demoDir = path.resolve(here, "..");
const repoRoot = path.resolve(demoDir, "../..");
const pythonSdk = path.join(repoRoot, "python/wevna");
const venvDir = path.join(demoDir, ".venv");
const venvPython = path.join(
  venvDir,
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);

const STOREFRONT = `http://localhost:${process.env.STOREFRONT_PORT ?? 3001}`;
const PRICING = `http://localhost:${process.env.PRICING_PORT ?? 3002}`;
const DASHBOARD_NODE = process.env.STOREFRONT_DASHBOARD_PORT ?? 4123;
const DASHBOARD_PYTHON = process.env.PRICING_DASHBOARD_PORT ?? 4124;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error || result.status !== 0) {
    fail(`Command failed: ${command} ${args.join(" ")}`);
  }
}

// --- Postgres and Redis --------------------------------------------------------

if (process.env.NO_DOCKER === "1") {
  console.log("NO_DOCKER=1: using the databases named by DATABASE_URL and REDIS_URL.");
} else {
  const docker = spawnSync("docker", ["compose", "version"], { stdio: "ignore" });
  if (docker.status !== 0) {
    fail(
      "Docker Compose was not found. Install Docker, or run your own Postgres and Redis and\n" +
        "start this with NO_DOCKER=1 (see examples/demo/README.md).",
    );
  }
  console.log("Starting Postgres and Redis...");
  run("docker", ["compose", "up", "-d", "--wait"], { cwd: demoDir });
}

// --- Python environment --------------------------------------------------------

if (!existsSync(path.join(pythonSdk, "src/wevna/dashboard/index.html"))) {
  fail(
    "The Python SDK has no dashboard bundle yet. Run `pnpm build` at the repository root first.",
  );
}
const stamp = path.join(venvDir, ".demo-installed");
if (!existsSync(stamp)) {
  console.log("Creating the Python environment (first run only)...");
  run(process.env.PYTHON ?? "python3", ["-m", "venv", venvDir]);
  run(venvPython, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"]);
  run(venvPython, [
    "-m",
    "pip",
    "install",
    "--quiet",
    "-e",
    `${pythonSdk}[sqlalchemy,redis,httpx]`,
    "fastapi",
    "uvicorn",
    "asyncpg",
  ]);
  writeFileSync(stamp, new Date().toISOString());
}

// --- The two services ----------------------------------------------------------

const children = [];

function start(name, command, args, options = {}) {
  const child = spawn(command, args, { cwd: demoDir, env: process.env, ...options });
  children.push(child);
  const prefix = `[${name}] `;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) {
          console.log(prefix + line);
        }
      }
    });
  }
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`${prefix}exited with code ${code}. Stopping.`);
      stop(1);
    }
  });
}

let stopping = false;
function stop(code = 0) {
  stopping = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const tsx = path.join(demoDir, "node_modules/.bin/tsx");
start("storefront", tsx, ["node-service/src/app.ts"]);
start("pricing", venvPython, ["python-service/app.py"]);

async function waitFor(url, name) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  fail(`${name} did not answer at ${url} within 60 seconds.`);
}

await Promise.all([
  waitFor(`${STOREFRONT}/health`, "storefront"),
  waitFor(`${PRICING}/health`, "pricing"),
]);

console.log(`
  Both services are up.

    Node storefront   ${STOREFRONT}     dashboard  http://localhost:${DASHBOARD_NODE}
    Python pricing    ${PRICING}     dashboard  http://localhost:${DASHBOARD_PYTHON}

  Open both dashboards side by side, then, in another terminal:

    pnpm --filter @wevna/example-demo traffic

  Ctrl-C stops the services. The databases keep running:
    pnpm --filter @wevna/example-demo demo:down
`);
