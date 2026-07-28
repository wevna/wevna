#!/usr/bin/env node
// Copies the dashboard's built static assets next to a package's own build
// output, so the published "wevna" package (and any other package that
// bundles server code) ships a self-contained dist/dashboard directory
// instead of depending on packages/dashboard existing at runtime.
//
// Usage: node scripts/copy-dashboard-assets.mjs <destination-relative-to-cwd>
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const dashboardDist = path.join(repoRoot, "packages/dashboard/dist");

const destinationArg = process.argv[2];
if (!destinationArg) {
  console.error("Usage: copy-dashboard-assets.mjs <destination>");
  process.exit(1);
}

const destination = path.resolve(process.cwd(), destinationArg);

await rm(destination, { recursive: true, force: true });
await cp(dashboardDist, destination, { recursive: true });

console.log(`Copied dashboard assets to ${path.relative(repoRoot, destination)}`);
