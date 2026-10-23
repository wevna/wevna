#!/usr/bin/env node
// Fails if git tracks a file that should never be committed: local working
// notes (draft posts, release and advisory drafts, work reports) and Python or
// JavaScript build output. Each of these is in .gitignore, but .gitignore does
// not stop `git add -f`, or a file added before its rule existed. A draft launch
// post and a directory of .pyc files both reached main that way.
//
// Usage: node scripts/check-tracked-files.mjs
import { execFileSync } from "node:child_process";

const RULES = [
  ["draft post", /(^|\/)[^/]*-POSTS?\.md$/],
  ["advisory draft", /(^|\/)ADVISORY-DRAFT\.md$/],
  ["release checklist", /(^|\/)RELEASE-CHECKLIST\.md$/],
  ["work report", /(^|\/)WORK-REPORT\.md$/],
  ["Python bytecode", /(^|\/)__pycache__\/|\.py[cod]$/],
  ["egg-info", /\.egg-info(\/|$)/],
  ["virtualenv", /(^|\/)\.venv\//],
  ["build output", /(^|\/)(dist|build)\//],
];

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const found = [];
for (const file of tracked) {
  const rule = RULES.find(([, pattern]) => pattern.test(file));
  if (rule) {
    found.push(`${file} (${rule[0]})`);
  }
}

if (found.length > 0) {
  console.error("These files are tracked but should not be committed:");
  for (const line of found) {
    console.error(`  ${line}`);
  }
  console.error("Remove them with `git rm --cached <path>`. They are already in .gitignore.");
  process.exit(1);
}

console.log(`No stray files among ${tracked.length} tracked files.`);
