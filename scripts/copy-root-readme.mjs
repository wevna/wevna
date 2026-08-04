#!/usr/bin/env node
// Copies the repo root README (the project's primary documentation) into a
// package directory so it ships inside that package's published tarball.
// Used by `wevna` specifically: it's the flagship package and effectively
// synonymous with the whole project, so its npm page should show the same
// comprehensive usage guide as the repository itself, rather than a thin
// package-specific stub — unlike @wevna/protocol and @wevna/plugin-fetch,
// which have their own small, hand-written READMEs (see their package
// directories) because they're narrower, secondary packages.
//
// The copy is generated at build time, the same way dist/ itself is (see
// copy-dashboard-assets.mjs) — it's gitignored, not a second source of
// truth to keep in sync by hand.
//
// Usage: node scripts/copy-root-readme.mjs [destination-relative-to-cwd]
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const rootReadme = path.join(repoRoot, "README.md");

const destinationArg = process.argv[2] ?? "README.md";
const destination = path.resolve(process.cwd(), destinationArg);

await copyFile(rootReadme, destination);

console.log(`Copied root README to ${path.relative(repoRoot, destination)}`);
