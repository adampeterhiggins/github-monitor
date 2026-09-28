#!/usr/bin/env node
/**
 * Where a linked worktree keeps what it builds, so the worktree can be deleted
 * without losing anything and without leaving gigabytes behind.
 *
 * In a linked worktree that is `node_modules/.cache/github-monitor`: T3 Code's
 * automatic worktree cleanup refuses a worktree holding any ignored path other
 * than `node_modules`, and everything under here goes with the worktree. The
 * main checkout (and the release worktree, which sets
 * GITHUB_MONITOR_WORKTREE_SCRATCH=0) keeps the usual `src-tauri/target`.
 *
 * Cargo learns this from `cargo.toml` in that directory, which the committed
 * `.cargo/config.toml` includes when it exists, so plain `cargo` and
 * `npm run tauri` follow it as well as make. Running this script writes that
 * file in a linked worktree and removes it anywhere else; make and npm's
 * postinstall run it.
 *
 *   node scripts/worktree-scratch.mjs   # sync the Cargo config; print the directory, or nothing
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SCRATCH = join("node_modules", ".cache", "github-monitor");

/** Where every worktree's intermediate Cargo artifacts go, shared between them. */
export const SHARED_BUILD_DIR = join(homedir(), "Library", "Caches", "github-monitor", "cargo-build");

function gitPaths(cwd) {
  try {
    const out = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const [gitDir, commonDir, top] = out.trim().split("\n");
    return { gitDir, commonDir, top };
  } catch {
    return null;
  }
}

/** The scratch directory for this checkout, or null outside a linked worktree. */
export function worktreeScratch(cwd = process.cwd()) {
  if (process.env.GITHUB_MONITOR_WORKTREE_SCRATCH === "0") return null;
  const git = gitPaths(cwd);
  // A linked worktree's git dir is its own, under the main one's worktrees/.
  if (!git || git.gitDir === git.commonDir) return null;
  return join(git.top, SCRATCH);
}

/** Write or remove the Cargo config `.cargo/config.toml` includes. */
export function syncCargoConfig(cwd = process.cwd()) {
  const scratch = worktreeScratch(cwd);
  if (!scratch) {
    const git = gitPaths(cwd);
    if (git) rmSync(join(git.top, SCRATCH, "cargo.toml"), { force: true });
    return null;
  }
  mkdirSync(scratch, { recursive: true });
  writeFileSync(
    join(scratch, "cargo.toml"),
    [
      "# Written by scripts/worktree-scratch.mjs for this linked worktree.",
      "[build]",
      `target-dir = ${JSON.stringify(join(scratch, "target"))}`,
      `build-dir = ${JSON.stringify(SHARED_BUILD_DIR)}`,
      "",
    ].join("\n"),
  );
  return scratch;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scratch = syncCargoConfig();
  if (scratch) console.log(scratch);
}
