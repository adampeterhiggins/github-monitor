import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApp } from "../lib/state/app";
import {
  allOwnershipReports, deleteManualMapping, listManualMappings, ownershipAccountIndex, ownershipAccountRevision,
  saveManualMapping, writeGithubUserHints, writeGithubUserLookup,
} from "../lib/db/lineOwnership";
import { GitHubClient } from "../lib/github/client";
import {
  exportMappings, mappingInventory, mappingPreview, planMappingImport, resolveImportLookups, sourceKey, statusLabel,
  type ImportInput, type ImportRow, type InventoryRow, type MappingSource,
} from "../lib/ownershipMappings";
import { resolveIdentity, type ManualMapping, type OwnershipAccountIndex } from "../lib/ownershipIdentity";
import { ownershipEngine, publishOwnership, setOwnershipEngine, type OwnershipEngine } from "../lib/ownershipEvents";
import { Button, Callout, Card, CardHeader, Checkbox, DataTable, Segmented, Spinner, full } from "./ui";

type Filter = "attention" | "all";

interface VerifiedAccount { id: string; login: string; cached: boolean }

/** A login the user typed, as an immutable account ID. Cached IDs work offline; new ones need GitHub. */
async function verifyAccount(input: string, index: OwnershipAccountIndex, token: string | null): Promise<VerifiedAccount> {
  const login = input.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new Error("That is not a GitHub login");
  const cached = index.loginToId.get(login.toLowerCase());
  if (cached) return { id: cached, login: index.users.get(cached)?.login ?? login, cached: true };
  if (!token) throw new Error("Sign in to verify a login that is not cached yet");
  const response = await new GitHubClient({ token }).request<{ id: number; login: string } | null>(
    `users/${encodeURIComponent(login)}`, { allowNotFound: true },
  );
  if (!response.data?.id) throw new Error(`No GitHub account is named ${login}`);
  return { id: String(response.data.id), login: response.data.login, cached: false };
}

/**
 * Settings → Contributor mappings. Automatic GitHub evidence always wins; a manual
 * mapping applies only to an otherwise unmatched identity (or, after review, to
 * one with conflicting automatic evidence). Mappings regroup existing attribution;
 * they never change which commit owns a line.
 */
export function OwnershipMappingsPanel() {
  const db = useApp((s) => s.db);
  const token = useApp((s) => s.token);
  const repos = useApp((s) => s.repos);
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("attention");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<InventoryRow | null>(null);
  const revision = useQuery({
    queryKey: ["ownership-account-revision"],
    enabled: db != null,
    queryFn: () => ownershipAccountRevision(db!),
  });
  const accounts = useQuery({
    queryKey: ["ownership-account-index", revision.data],
    enabled: db != null && revision.data != null,
    queryFn: () => ownershipAccountIndex(db!),
    staleTime: Infinity,
  });
  const reports = useQuery({
    queryKey: ["ownership-mapping-reports"],
    enabled: db != null,
    queryFn: () => allOwnershipReports(db!),
    staleTime: 60_000,
  });
  const manual = useQuery({
    queryKey: ["ownership-manual-mappings", revision.data],
    enabled: db != null,
    queryFn: () => listManualMappings(db!),
  });
  const repoName = useMemo(() => new Map(repos.map((r) => [r.id, r.full_name])), [repos]);
  const inventory = useMemo(() => accounts.data && reports.data
    ? mappingInventory(reports.data.map((r) => ({ repoId: r.repoId, report: r.report, legacyHistory: r.history.kind === "legacy" })), accounts.data)
    : [], [accounts.data, reports.data]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inventory.filter((row) => (filter === "all" || row.status === "unmatched" || row.status === "conflict" || row.status === "superseded")
      && (!q || [...row.names, row.email ?? "", row.login ?? ""].some((v) => v.toLowerCase().includes(q))));
  }, [inventory, filter, query]);
  const changed = async () => {
    publishOwnership({ kind: "mappings" });
    publishOwnership({ kind: "accounts" });
    await queryClient.invalidateQueries({ queryKey: ["ownership-account-revision"] });
  };
  const loading = reports.isLoading || accounts.isLoading;
  const unmatched = inventory.filter((r) => r.status === "unmatched");
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Line ownership contributor mappings"
          subtitle="Attach Git authors that GitHub could not match to a verified account. Line ownership then counts them under that login on every page."
        />
        {loading ? <p className="text-[12px] text-ink-secondary"><Spinner /> Reading saved snapshots…</p> : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Segmented ariaLabel="Which authors" value={filter} onChange={setFilter}
                options={[{ value: "attention", label: `Needs attention (${full(inventory.filter((r) => r.status === "unmatched" || r.status === "conflict" || r.status === "superseded").length)})` }, { value: "all", label: `All (${full(inventory.length)})` }]} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or email…"
                className="h-7 w-64 rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-ink placeholder:text-ink-muted" />
              <span className="ml-auto text-[11px] text-ink-muted">{full(unmatched.length)} unmatched · {full(unmatched.reduce((n, r) => n + r.lines, 0))} credited lines</span>
            </div>
            <DataTable rows={visible} rowKey={(r) => r.key} maxHeight={440} initialSort={{ key: "lines", dir: "desc" }}
              empty={filter === "attention" ? "Every Git author with surviving lines is matched to an account." : "No authors match."} columns={[
                { key: "author", header: "Git author", render: (r) => <span className="whitespace-normal">{r.names.join(" · ") || "—"}{r.email ? <span className="block text-[11px] text-ink-muted">{r.email}</span> : <span className="block text-[11px] text-ink-muted">No email · only in {repoName.get(r.source.repoId!) ?? "one repository"}</span>}</span>, sortValue: (r) => r.names[0] ?? r.email ?? "" },
                { key: "repos", header: "Repositories", align: "right", render: (r) => full(r.repoIds.length), sortValue: (r) => r.repoIds.length },
                { key: "lines", header: "Surviving lines", align: "right", render: (r) => full(r.lines), sortValue: (r) => r.lines },
                { key: "status", header: "Match", render: (r) => <span title={r.conflictIds.length ? `GitHub IDs ${r.conflictIds.join(", ")}` : undefined}>{statusLabel(r)}{r.login && r.status !== "unmatched" && r.status !== "conflict" ? ` · @${r.login}` : ""}</span>, sortValue: (r) => r.status },
                { key: "history", header: "History", render: (r) => r.historyResolved ? "Account-resolved" : "Legacy · rebuilds on next sync" },
                { key: "action", header: "", render: (r) => r.status === "github" || r.status === "provisional" || r.status === "superseded" ? null
                  : <Button variant="ghost" onClick={() => setEditing(r)}>{r.status === "manual" ? "Edit" : "Map…"}</Button> },
              ]} />
          </>
        )}
      </Card>
      {editing && accounts.data && db && <MappingEditor key={editing.key} row={editing} inventory={inventory} index={accounts.data}
        token={token} repoName={repoName.get(editing.source.repoId ?? -1) ?? null}
        onCancel={() => setEditing(null)}
        onSave={async (source, account, reviewed) => {
          if (!account.cached) await writeGithubUserLookup(db, account.id, account.login);
          await saveManualMapping(db, {
            matchKind: source.kind, matchValue: source.value, repoId: source.repoId,
            githubId: account.id, loginAtSave: account.login, reviewedAutoConflict: reviewed,
          });
          setEditing(null);
          await changed();
        }} />}
      <SavedMappings mappings={manual.data ?? []} index={accounts.data} repoName={repoName} inventory={inventory} token={token}
        repos={repos.map((r) => ({ id: r.id, fullName: r.full_name }))}
        onRemove={async (mapping) => {
          if (!db) return;
          await deleteManualMapping(db, mapping.mappingId);
          await changed();
        }}
        onImport={async (rows) => {
          if (!db) return;
          await writeGithubUserHints(db, rows.map((r) => ({ id: r.githubId, login: r.loginAtSave })));
          for (const row of rows) await saveManualMapping(db, row);
          await changed();
        }} />
      <HistoryEngineCard />
    </div>
  );
}

function MappingEditor({ row, inventory, index, token, repoName, onCancel, onSave }: {
  row: InventoryRow;
  inventory: readonly InventoryRow[];
  index: OwnershipAccountIndex;
  token: string | null;
  repoName: string | null;
  onCancel: () => void;
  onSave: (source: MappingSource, account: VerifiedAccount, reviewed: boolean) => Promise<void>;
}) {
  const [input, setInput] = useState(row.manual?.loginAtSave ?? "");
  const [account, setAccount] = useState<VerifiedAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(row.manual?.reviewedAutoConflict ?? false);
  const known = useMemo(() => [...index.users.values()].sort((a, b) => a.login.localeCompare(b.login)), [index]);
  const preview = mappingPreview(inventory, row.source);
  const needsReview = row.conflictIds.length > 0;
  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      setAccount(await verifyAccount(input, index, token));
    } catch (e) {
      setAccount(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title={`Map ${row.names[0] ?? row.email ?? "this author"}`}
        subtitle={row.source.kind === "email" ? `All repositories with ${row.email}` : `Only ${row.names[0] ?? "this name"} without an email in ${repoName ?? "this repository"} — never other repositories or people who share the name`} />
      <div className="flex flex-col gap-3 text-[12px]">
        {needsReview && <Callout tone="warning">
          GitHub has matched this email to more than one account (IDs {row.conflictIds.join(", ")}), so it is not attached automatically. Choose the right account only after checking which one it is.
        </Callout>}
        <label className="flex flex-wrap items-center gap-2">GitHub login
          <input list="ownership-known-accounts" value={input} onChange={(e) => { setInput(e.target.value); setAccount(null); }}
            placeholder="login" className="h-7 w-56 rounded-md border border-hairline-strong bg-surface px-2 text-ink" />
          <datalist id="ownership-known-accounts">{known.map((u) => <option key={u.id} value={u.login} />)}</datalist>
          <Button onClick={verify} disabled={busy || !input.trim()}>{busy ? "Checking…" : "Verify"}</Button>
        </label>
        {error && <p className="text-critical">{error}</p>}
        {account && <p>
          <strong>@{account.login}</strong> · GitHub ID {account.id}{account.cached ? " · already known" : " · verified with GitHub"}
        </p>}
        {needsReview && <Checkbox checked={reviewed} onChange={setReviewed} label="I have reviewed the conflicting automatic matches" />}
        <p className="text-ink-secondary">
          {account
            ? `This maps ${full(preview.identities)} Git ${preview.identities === 1 ? "identity" : "identities"} and ${full(preview.lines)} credited surviving lines across ${full(preview.repositories)} ${preview.repositories === 1 ? "repository" : "repositories"} to @${account.login}.`
            : "Verify an account to see what this mapping changes."}
          {" "}Line attribution is unchanged; only who the lines count for.
        </p>
        <div className="flex gap-2">
          <Button disabled={!account || busy || (needsReview && !reviewed)} onClick={async () => {
            if (!account) return;
            setBusy(true);
            try {
              await onSave(row.source, account, needsReview && reviewed);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}>Save mapping</Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </Card>
  );
}

function download(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SavedMappings({ mappings, index, repoName, inventory, token, repos, onRemove, onImport }: {
  mappings: readonly ManualMapping[];
  index: OwnershipAccountIndex | undefined;
  repoName: ReadonlyMap<number, string>;
  inventory: readonly InventoryRow[];
  token: string | null;
  repos: ReadonlyArray<{ id: number; fullName: string }>;
  onRemove: (mapping: ManualMapping) => Promise<void>;
  onImport: (rows: ImportInput[]) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<number | null>(null);
  const [plan, setPlan] = useState<{ name: string; rows: ImportRow[] } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(0);
  const todo = inventory.filter((r) => r.status === "unmatched" || r.status === "conflict").length;
  const fileInput = useRef<HTMLInputElement>(null);
  const count = (status: ImportRow["status"]) => plan?.rows.filter((r) => r.status === status).length ?? 0;
  const apply = async (statuses: ReadonlyArray<ImportRow["status"]>) => {
    if (!plan) return;
    const rows = plan.rows.filter((r) => statuses.includes(r.status) && r.input).map((r) => r.input!);
    setImporting(true);
    setImportError(null);
    try {
      await onImport(rows);
      setImported(`Imported ${full(rows.length)} ${rows.length === 1 ? "mapping" : "mappings"} from ${plan.name}.`);
      setPlan(null);
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setImporting(false);
    }
  };
  return (
    <Card>
      <CardHeader title="Saved mappings" subtitle="Removing one returns its lines to an unmatched Git identity. Kept when the analytics cache is cleared." />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px]">
        <Button disabled={mappings.length === 0 && todo === 0}
          title="Save every mapping, plus an entry to fill in for each unmatched author, to a file you can edit and import"
          onClick={() => download(`contributor-mappings-${new Date().toISOString().slice(0, 10)}.json`,
            JSON.stringify(exportMappings(mappings, repoName, index, inventory), null, 2) + "\n")}>
          Export…
        </Button>
        <Button onClick={() => { setImported(null); setImportError(null); fileInput.current?.click(); }}>Import…</Button>
        <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const result = planMappingImport(await file.text(), mappings, repos);
          if (result.error) {
            setPlan(null);
            setImportError(result.error);
            return;
          }
          // Login-only entries need an account ID: cached logins resolve offline, the rest ask GitHub.
          const pending = result.rows.filter((r) => r.status === "lookup").length;
          setLookingUp(pending);
          setPlan({ name: file.name, rows: result.rows });
          if (!pending || !index) { setLookingUp(0); return; }
          const rows = await resolveImportLookups(result.rows, mappings, async (login) => {
            try {
              const account = await verifyAccount(login, index, token);
              return { id: account.id, login: account.login };
            } catch (err) {
              return (err as Error).message;
            } finally {
              setLookingUp((n) => Math.max(0, n - 1));
            }
          });
          setLookingUp(0);
          setPlan({ name: file.name, rows });
        }} />
        {imported && <span className="text-ink-secondary">{imported}</span>}
      </div>
      {importError && <Callout tone="critical">{importError}</Callout>}
      {plan && <div className="mb-4 flex flex-col gap-2 rounded-md border border-hairline p-3 text-[12px]">
        <p><strong>{plan.name}</strong>: {full(count("new"))} new, {full(count("change"))} {count("change") === 1 ? "changes" : "change"} an existing mapping, {full(count("same"))} already saved, {full(count("unfilled"))} left empty, {full(count("invalid"))} cannot be imported.</p>
        {lookingUp > 0 && <p className="text-ink-secondary"><Spinner /> Looking up {full(lookingUp)} GitHub {lookingUp === 1 ? "login" : "logins"}…</p>}
        <p className="text-ink-secondary">Imported logins are only a label until GitHub confirms them: each mapping keeps the account ID from the file. Automatic GitHub matches still take precedence, as for mappings made here.</p>
        <DataTable rows={plan.rows.filter((r) => r.status !== "same" && r.status !== "unfilled")} rowKey={(r) => `${r.status}:${r.label}:${r.reason ?? ""}`} maxHeight={260}
          empty="Every mapping in this file is already saved." columns={[
            { key: "author", header: "Git author", render: (r) => <span className="whitespace-normal">{r.label}</span> },
            { key: "account", header: "Account", render: (r) => r.input ? `@${r.input.loginAtSave}${r.input.githubId ? ` · ID ${r.input.githubId}` : ""}` : "—" },
            { key: "status", header: "", render: (r) => r.status === "new" ? "New" : r.status === "change" ? `Replaces ${r.previous}` : r.status === "lookup" ? "Looking up…" : <span className="text-ink-muted">{r.reason}</span> },
          ]} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={importing || lookingUp > 0 || count("new") + count("change") === 0} onClick={() => apply(["new", "change"])}>
            {importing ? "Importing…" : `Import ${full(count("new") + count("change"))}`}
          </Button>
          {count("change") > 0 && <Button variant="ghost" disabled={importing || lookingUp > 0 || count("new") === 0} onClick={() => apply(["new"])}>Only new ({full(count("new"))})</Button>}
          <Button variant="ghost" disabled={importing} onClick={() => setPlan(null)}>Cancel</Button>
        </div>
      </div>}
      <DataTable rows={[...mappings]} rowKey={(m) => m.mappingId} empty="No manual mappings yet." columns={[
        { key: "source", header: "Git author", render: (m) => m.matchKind === "email" ? `${m.matchValue} · all repositories` : `${m.matchValue} · no email, only in ${repoName.get(m.repoId ?? -1) ?? `repository ${m.repoId}`}` },
        { key: "account", header: "Account", render: (m) => {
          const current = index?.users.get(m.githubId)?.login;
          return `@${current ?? m.loginAtSave} · ID ${m.githubId}${current && current !== m.loginAtSave ? ` (saved as @${m.loginAtSave})` : ""}`;
        } },
        { key: "state", header: "State", render: (m) => {
          if (!index) return "—";
          const probe = m.matchKind === "email" ? { name: "", email: m.matchValue } : { name: m.matchValue, email: "", repoId: m.repoId };
          const resolved = resolveIdentity(probe, index);
          return resolved.source === "manual" ? (m.reviewedAutoConflict ? "Active · conflict reviewed" : "Active") : resolved.superseded ? "Superseded by automatic match" : "Not applied";
        } },
        { key: "remove", header: "", render: (m) => confirm === m.mappingId
          ? <span className="flex gap-1"><Button variant="ghost" onClick={async () => { await onRemove(m); setConfirm(null); }}>Remove</Button><Button variant="ghost" onClick={() => setConfirm(null)}>Keep</Button></span>
          : <Button variant="ghost" onClick={() => setConfirm(m.mappingId)}>Remove…</Button> },
      ]} />
    </Card>
  );
}

function HistoryEngineCard() {
  const [engine, setEngine] = useState<OwnershipEngine>(() => ownershipEngine());
  return (
    <Card>
      <CardHeader title="History engine" subtitle="How the daily ownership history is calculated during sync" />
      <div className="flex flex-col gap-2 text-[12px] text-ink-secondary">
        <Segmented ariaLabel="History engine" value={engine} onChange={(value) => { setOwnershipEngine(value); setEngine(value); }}
          options={[{ value: "replay", label: "Replay (default)" }, { value: "blame", label: "Blame (reference, slower)" }]} />
        <p>Replay applies each commit's diff to the previous attribution and runs <code>git blame</code> only where a diff cannot decide: merges, renames and binary changes. Blame re-runs <code>git blame</code> for every changed file at every commit; choose it if a repository's history ever looks wrong. Every finished history is checked against a full blame of the default branch, and a replayed history that differs is rebuilt with blame automatically. Changing the engine rebuilds history on the next sync while the current chart stays visible.</p>
      </div>
    </Card>
  );
}

export { sourceKey };
