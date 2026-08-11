#!/usr/bin/env node
/**
 * Generate the Tauri updater manifest for a published release.
 *
 *   GH_TOKEN=… node scripts/build-update-manifest.mjs --tag v0.2.0 [--out latest.json]
 *
 * Why this exists rather than pointing the updater at
 * `releases/latest/download/latest.json`: that URL only works on a public
 * repository. This repository is private, so the manifest must reference each
 * asset by its **API** URL —
 * `https://api.github.com/repos/O/R/releases/assets/<id>` — which honours a bearer
 * token. Asset ids only exist after upload, hence generating the manifest as a
 * post-publish step.
 *
 * The app sends only an `Authorization` header; the updater then defaults `Accept`
 * to `application/json` for the manifest and `application/octet-stream` for the
 * download, which is exactly what each endpoint needs.
 *
 * One universal macOS build serves both architectures, so both platform keys point
 * at the same asset.
 */

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const tag = argOf("--tag");
const out = argOf("--out", "latest.json");
const repo = argOf("--repo", process.env.GITHUB_REPOSITORY ?? "adampeterhiggins/github-monitor");
const sigPath = argOf("--signature");
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

if (!tag || !token) {
  console.error(
    "usage: GH_TOKEN=… node scripts/build-update-manifest.mjs --tag <tag> [--out latest.json] [--signature path]",
  );
  process.exit(2);
}

const api = async (path, { allow404 = false } = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 404 && allow404) return null;
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} on ${path}: ${await res.text()}`);
  }
  return res.json();
};

/**
 * Find the release for a tag.
 *
 * `/releases/tags/{tag}` is the direct route but 404s for **draft** releases,
 * because a draft has no tag until it is published. The real workflow publishes
 * before this runs, so the direct route normally succeeds; the listing fallback
 * exists so the pipeline can also be exercised against a draft without publishing
 * anything.
 */
async function findRelease() {
  const direct = await api(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    allow404: true,
  });
  if (direct) return direct;

  const all = await api(`/repos/${repo}/releases?per_page=100`);
  const match = (all ?? []).find((r) => r.tag_name === tag);
  if (!match) {
    throw new Error(
      `No release found for tag ${tag} in ${repo} (checked published and draft releases).`,
    );
  }
  console.log(`Note: ${tag} is a draft release; found it via the release listing.`);
  return match;
}

const release = await findRelease();

// The updater installs from the tarball, not the .dmg — the .dmg is for humans.
const tarball = release.assets.find((a) => a.name.endsWith(".app.tar.gz"));
if (!tarball) {
  console.error(
    `Release ${tag} has no .app.tar.gz asset. The build must run with ` +
      `createUpdaterArtifacts enabled and upload it.`,
  );
  console.error(`assets present: ${release.assets.map((a) => a.name).join(", ") || "(none)"}`);
  process.exit(1);
}

// The signature is produced beside the tarball at build time. Prefer a local file
// (same run), and fall back to the uploaded .sig asset.
let signature = null;
if (sigPath) {
  signature = readFileSync(sigPath, "utf8").trim();
} else {
  const sigAsset = release.assets.find((a) => a.name.endsWith(".app.tar.gz.sig"));
  if (!sigAsset) {
    console.error(`Release ${tag} has no .app.tar.gz.sig asset and no --signature was given.`);
    process.exit(1);
  }
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${sigAsset.id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/octet-stream" },
  });
  if (!res.ok) {
    console.error(`Could not download the signature asset: HTTP ${res.status}`);
    process.exit(1);
  }
  signature = (await res.text()).trim();
}

if (!signature) {
  console.error("Empty signature — refusing to publish a manifest the app cannot verify.");
  process.exit(1);
}

const url = `https://api.github.com/repos/${repo}/releases/assets/${tarball.id}`;
const version = tag.replace(/^v/, "");

const manifest = {
  version,
  // Shown in the app's Updates card.
  notes: (release.body ?? "").trim() || `Version ${version}`,
  pub_date: release.published_at ?? release.created_at ?? new Date().toISOString(),
  platforms: {
    // A universal binary covers both, so both keys reference the same asset.
    "darwin-aarch64": { signature, url },
    "darwin-x86_64": { signature, url },
  },
};

writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${out}`);
console.log(`  version:   ${manifest.version}`);
console.log(`  asset:     ${tarball.name} (id ${tarball.id}, ${tarball.size} bytes)`);
console.log(`  url:       ${url}`);
console.log(`  signature: ${signature.slice(0, 24)}… (${signature.length} chars)`);
