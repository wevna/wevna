import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

// The dashboard's built assets can live in one of two places, checked in
// order:
//
// 1. Co-located with this module's own compiled output (`<here>/dashboard`).
//    scripts/copy-dashboard-assets.mjs populates this as part of the
//    published "wevna" package's build, so the assets travel with the
//    compiled code even where packages/dashboard doesn't exist at all (a
//    real consumer's node_modules).
// 2. packages/dashboard's own Vite build output, resolved by a fixed
//    monorepo-relative path. This lets `pnpm dev` and standalone server
//    development serve the dashboard without needing the copy step, as
//    long as the dashboard package has been built at least once.
//
// Neither __dirname nor import.meta.url is safe to use alone here: this
// module runs as native CJS (__dirname works, import.meta is stripped to
// nothing by esbuild), as tsup's ESM build output, and as raw source under
// tsx/vitest in dev and tests (where __dirname is undefined). Checking
// __dirname first and falling back to import.meta.url covers all of them.
function getCurrentDir(): string {
  if (typeof __dirname !== "undefined") {
    return __dirname;
  }
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveDashboardDir(): string | undefined {
  const currentDir = getCurrentDir();
  const candidates = [
    path.join(currentDir, "dashboard"),
    path.resolve(currentDir, "../../dashboard/dist"),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

export function registerDashboard(app: FastifyInstance, dashboardDir?: string): void {
  const resolvedDir = dashboardDir ?? resolveDashboardDir();

  if (!resolvedDir) {
    app.log.warn(
      "Wevna dashboard assets were not found. Build the dashboard package " +
        "(`pnpm --filter @wevna/dashboard build`) to serve the UI; the health " +
        "endpoint will keep working regardless.",
    );
    return;
  }

  app.register(fastifyStatic, {
    root: resolvedDir,
    index: ["index.html"],
  });
}
