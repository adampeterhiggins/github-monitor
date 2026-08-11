#!/usr/bin/env node
/**
 * Validate the GitHub Actions workflows locally.
 *
 *   npm run check:workflows
 *
 * A release depends entirely on this YAML being correct, and the feedback loop for
 * "push a tag and see" is slow and leaves broken tags behind. This catches parse
 * errors, missing job dependencies and undeclared secrets before pushing.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const dir = ".github/workflows";
let failures = 0;

const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failures++;
};

for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
  const path = join(dir, file);
  const text = readFileSync(path, "utf8");

  let doc;
  try {
    doc = parse(text);
  } catch (err) {
    fail(`${file}: does not parse — ${err.message}`);
    continue;
  }

  // `on:` is YAML 1.1 truthy, so some parsers surface it as the boolean key `true`.
  const triggers = doc.on ?? doc[true];
  if (!triggers) fail(`${file}: no triggers`);
  if (!doc.jobs || Object.keys(doc.jobs).length === 0) {
    fail(`${file}: no jobs`);
    continue;
  }

  const jobNames = Object.keys(doc.jobs);
  for (const [name, job] of Object.entries(doc.jobs)) {
    if (!job["runs-on"]) fail(`${file}: job '${name}' has no runs-on`);
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      fail(`${file}: job '${name}' has no steps`);
    }
    for (const dep of [job.needs ?? []].flat()) {
      if (!jobNames.includes(dep)) fail(`${file}: job '${name}' needs unknown job '${dep}'`);
    }
    // A job that writes to the repo must say so, or the token is read-only.
    const writes = JSON.stringify(job).includes("action-gh-release") ||
      JSON.stringify(job).includes("git push");
    const perms = job.permissions?.contents ?? doc.permissions?.contents;
    if (writes && perms !== "write") {
      fail(`${file}: job '${name}' publishes but lacks contents: write`);
    }
  }

  const secrets = [...new Set([...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
  console.log(
    `PASS  ${file}: ${jobNames.length} jobs (${jobNames.join(" -> ")})` +
      (secrets.length ? `; secrets: ${secrets.join(", ")}` : ""),
  );
}

console.log(failures === 0 ? "\nWorkflows look valid." : `\n${failures} problem(s) found.`);
process.exit(failures === 0 ? 0 : 1);
