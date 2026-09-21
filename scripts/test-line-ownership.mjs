#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const work = mkdtempSync(join(tmpdir(), "gm-ownership-"));
try {
  const output = join(work, "ownership.cjs");
  await build({
    entryPoints: ["src/lib/lineOwnership.ts"], bundle: true, platform: "node", format: "cjs", outfile: output,
    plugins: [{ name: "tauri-fixture", setup(build) {
      build.onResolve({ filter: /^@tauri-apps\/api\/core$|^\.\/state\/app$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: args.path.includes("state/app")
        ? 'export const useApp = { getState: () => ({ token: "fixture-token" }) };'
        : 'export class Channel {} export const invoke = (...args) => globalThis.__invoke(...args);' }));
    } }],
  });
  const { ownershipCsv, useLineOwnership } = createRequire(import.meta.url)(output);
  const report = { totalLines: 3, authors: [
    { author: 'Name, "Quoted"', lines: 3, share: 1, emails: ["person@example.com"] },
    { author: '=HYPERLINK("evil")', lines: 1, share: 1 / 3, emails: ["+formula@example.com"] },
  ] };
  const csv = ownershipCsv(report);
  assert.ok(csv.includes('"Name, ""Quoted""","3","1","person@example.com"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""evil"")"'));
  assert.ok(csv.includes('"\'+formula@example.com"'));
  assert.ok(csv.endsWith('"Surviving lines","3","",""\r\n'));
  let resolveScan;
  let calls = 0;
  globalThis.__invoke = (command, args) => {
    calls++;
    assert.equal(command, "scan_line_ownership");
    assert.equal(args.githubRepo, "org/repo");
    assert.equal(args.token, "fixture-token");
    assert.equal(args.options.token, undefined);
    args.onProgress.onmessage({ completed: 1, total: 2, phase: "Blaming files" });
    return new Promise((resolve) => { resolveScan = resolve; });
  };
  const pending = useLineOwnership.getState().scan({ repo: "" }, "org/repo");
  assert.equal(useLineOwnership.getState().running, true);
  assert.equal(useLineOwnership.getState().progress.completed, 1);
  await useLineOwnership.getState().scan({ repo: "" }, "org/repo");
  assert.equal(calls, 1, "duplicate scans must not start");
  resolveScan(report);
  await pending;
  assert.equal(useLineOwnership.getState().report, report);
  assert.equal(useLineOwnership.getState().running, false);
  globalThis.__invoke = async (_, args) => {
    assert.equal(args.token, null, "local scans do not receive the token");
    assert.equal(args.githubRepo, null);
    throw new Error("Scan cancelled");
  };
  await useLineOwnership.getState().scan({ repo: "/local" });
  assert.equal(useLineOwnership.getState().report, null, "failed new scans must not display old results");
  assert.equal(useLineOwnership.getState().running, false);
  assert.match(useLineOwnership.getState().error, /cancelled/);
  console.log("PASS  ownership CSV escaping, formula safety, scan state, progress, duplicate prevention and credential scope");
} finally {
  rmSync(work, { recursive: true, force: true });
}
