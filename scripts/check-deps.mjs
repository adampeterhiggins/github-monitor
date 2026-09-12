#!/usr/bin/env node
/**
 * Check that node_modules matches package-lock.json.
 *
 *   node scripts/check-deps.mjs          # exit 1 and list what is off
 *   node scripts/check-deps.mjs --quiet  # exit code only
 *
 * A stale install fails typecheck with "Cannot find module" for anything a
 * teammate added since you last ran npm install. That once aborted a release
 * *after* the version had been bumped, leaving a half-done bump in the tree.
 * The Makefile runs this before every check and runs `npm ci` when it fails.
 *
 * Every non-optional entry in the lockfile must exist under node_modules at the
 * locked version. Optional entries are skipped: they are mostly other platforms'
 * native binaries, which npm rightly does not install here.
 */

import { existsSync, readFileSync } from "node:fs";

const quiet = process.argv.includes("--quiet");
const say = (msg) => { if (!quiet) console.log(msg); };

if (!existsSync("package-lock.json")) {
  say("No package-lock.json — nothing to compare against.");
  process.exit(1);
}
if (!existsSync("node_modules")) {
  say("node_modules is missing.");
  process.exit(1);
}

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const problems = [];

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path || entry.optional || entry.link) continue;
  let installed;
  try {
    installed = JSON.parse(readFileSync(`${path}/package.json`, "utf8"));
  } catch {
    problems.push(`missing   ${path}`);
    continue;
  }
  if (entry.version && installed.version !== entry.version) {
    problems.push(`version   ${path} has ${installed.version}, lockfile wants ${entry.version}`);
  }
}

if (problems.length === 0) {
  say("node_modules matches package-lock.json.");
  process.exit(0);
}

say(`node_modules is out of step with package-lock.json (${problems.length} package${problems.length === 1 ? "" : "s"}):`);
for (const p of problems.slice(0, 20)) say(`  ${p}`);
if (problems.length > 20) say(`  … and ${problems.length - 20} more`);
say("Run 'npm ci' (or 'make deps') to fix it.");
process.exit(1);
