# Security Policy

## What this app handles

GitHub Monitor reads your GitHub data with a personal access token you provide:

- A PAT with `repo`/`read:org` scope, entered directly or imported from `gh auth token`, stored via `tauri-plugin-store` in the app's data directory
- Repository metadata, contribution stats, and traffic data fetched from `api.github.com`, cached in a local SQLite database in the app's data directory

The token is only ever sent to `api.github.com`. There is no telemetry and no third-party endpoint. The webview's network surface is restricted to a host allowlist (`src-tauri/capabilities/default.json`), and shell access is limited to `gh auth token`.

## Reporting a vulnerability

Please report security issues privately via GitHub: [report a vulnerability](https://github.com/adampeterhiggins/github-monitor/security/advisories/new).

Do not open a public issue for security reports.
