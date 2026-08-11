import { useState } from "react";
import { useApp } from "../lib/state/app";
import { importTokenFromGhCli, summariseScopes } from "../lib/auth";
import { GitHubClient } from "../lib/github/client";
import { listOrgs } from "../lib/github/endpoints";
import { Button, Callout, Card, Spinner } from "../components/ui";

/** First-run: get a token, then pick the organisation to analyse. */
export function Setup() {
  const { token, setToken, setOrg } = useApp();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<Array<{ login: string; avatar_url: string }> | null>(null);
  const [orgInput, setOrgInput] = useState("");

  const verifyAndSave = async (candidate: string) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const client = new GitHubClient({ token: candidate });
      const { login, scopeHeader } = await client.verify();
      const scopes = summariseScopes(login, scopeHeader);
      await setToken(candidate);
      const list = await listOrgs(client);
      setOrgs(list);
      setInfo(
        `Signed in as ${login}.` +
          (scopes.missing.length
            ? ` Note: the token is missing ${scopes.missing.join(", ")}. Some pages will be empty.`
            : ""),
      );
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const useGhCli = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await importTokenFromGhCli();
      if (!t) {
        setError(
          "Could not read a token from the gh CLI. Install it and run `gh auth login`, or paste a personal access token below.",
        );
        return;
      }
      setInput(t);
      await verifyAndSave(t);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-xl">
        <h1 className="mb-1 text-[22px] font-semibold text-ink">GitHub Monitor</h1>
        <p className="mb-5 text-[13px] text-ink-secondary">
          Organisation-wide contribution analytics — the same charts GitHub gives you per
          repository, aggregated across every repository you choose.
        </p>

        <Card className="mb-3">
          <h2 className="mb-1 text-[14px] font-semibold text-ink">1. Connect to GitHub</h2>
          <p className="mb-3 text-[12px] leading-relaxed text-ink-secondary">
            A token needs <code className="text-ink">repo</code> and{" "}
            <code className="text-ink">read:org</code>. Traffic data additionally requires push
            access to each repository, which is GitHub's rule, not ours.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={useGhCli} disabled={busy}>
              {busy ? <Spinner /> : null} Import from gh CLI
            </Button>
            <span className="text-[11px] text-ink-muted">or paste a token</span>
          </div>

          <div className="mt-2 flex gap-2">
            <input
              type="password"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="ghp_… or gho_…"
              className="h-8 flex-1 rounded-md border border-hairline-strong bg-surface px-2.5 text-[12px] text-ink placeholder:text-ink-muted focus:outline-2 focus:outline-offset-0 focus:outline-accent"
            />
            <Button size="md" onClick={() => verifyAndSave(input)} disabled={busy || !input.trim()}>
              Verify
            </Button>
          </div>

          {error ? (
            <div className="mt-3">
              <Callout tone="critical">{error}</Callout>
            </div>
          ) : null}
          {info ? (
            <div className="mt-3">
              <Callout>{info}</Callout>
            </div>
          ) : null}
        </Card>

        {token ? (
          <Card>
            <h2 className="mb-1 text-[14px] font-semibold text-ink">2. Choose an organisation</h2>
            <p className="mb-3 text-[12px] text-ink-secondary">
              Every page aggregates across this organisation's repositories.
            </p>

            {orgs && orgs.length > 0 ? (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {orgs.map((o) => (
                  <Button key={o.login} onClick={() => void setOrg(o.login)}>
                    {o.login}
                  </Button>
                ))}
              </div>
            ) : null}

            <div className="flex gap-2">
              <input
                value={orgInput}
                onChange={(e) => setOrgInput(e.target.value)}
                placeholder="organisation login, e.g. focaldata"
                className="h-8 flex-1 rounded-md border border-hairline-strong bg-surface px-2.5 text-[12px] text-ink placeholder:text-ink-muted focus:outline-2 focus:outline-offset-0 focus:outline-accent"
              />
              <Button size="md" variant="primary" onClick={() => void setOrg(orgInput)} disabled={!orgInput.trim()}>
                Continue
              </Button>
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
