#!/usr/bin/env node
/**
 * Set the release version in the three places that must agree.
 *
 *   node scripts/set-version.mjs 0.2.0
 *   node scripts/set-version.mjs 0.2.0 --github-output
 *
 * `tauri.conf.json` is the version the updater compares against, so if it drifts
 * from `package.json` the app either offers an update it already has or never
 * offers one at all. Cargo.toml is kept aligned so `cargo` metadata is not
 * misleading.
 */

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const raw = process.argv[2];
if (!raw) {
  console.error("usage: node scripts/set-version.mjs <version> [--github-output]");
  process.exit(2);
}

const version = raw.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Not a valid semver version: ${version}`);
  process.exit(2);
}

// package.json
const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const previous = pkg.version;
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// tauri.conf.json — the one the updater actually compares
const confPath = "src-tauri/tauri.conf.json";
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = version;
writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);

// Cargo.toml — only the first `version =` under [package]
const cargoPath = "src-tauri/Cargo.toml";
let cargo = readFileSync(cargoPath, "utf8");
let replaced = false;
cargo = cargo.replace(/^version\s*=\s*".*"$/m, (line) => {
  if (replaced) return line;
  replaced = true;
  return `version = "${version}"`;
});
writeFileSync(cargoPath, cargo);

console.log(`${previous} -> ${version} (package.json, tauri.conf.json, Cargo.toml)`);

if (process.argv.includes("--github-output") && process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nprevious=${previous}\n`);
}
