#!/usr/bin/env node
/**
 * Line ownership: identity, selection, history projection, storage and sync.
 *
 *   npm run test:line-ownership
 *
 * Account-aligned identity is an intentional change from the name-merging rules
 * it replaced: a shared display name no longer joins two people, and a bare Git
 * name is no longer a selection. Those cases are asserted in their new form below
 * and listed in docs/line-ownership-identity.md.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const work = mkdtempSync(join(tmpdir(), "gm-ownership-"));
const sqlites = [];
try {
  const output = join(work, "ownership.cjs");
  const modules = [
    "src/lib/lineOwnership.ts", "src/lib/ownershipIdentity.ts", "src/lib/ownershipHistory.ts", "src/lib/ownershipMappings.ts",
    "src/lib/contributorSelection.ts", "src/lib/db/lineOwnership.ts", "src/lib/db/index.ts", "src/lib/db/schema.ts",
    "src/lib/ingest/sync.ts", "src/lib/ingest/lineOwnership.ts",
  ];
  await build({
    stdin: { contents: modules.map((path) => `export * from ${JSON.stringify(resolve(path))};`).join("\n"), resolveDir: process.cwd() },
    bundle: true, platform: "node", format: "cjs", outfile: output, logLevel: "error",
    plugins: [{ name: "tauri-fixture", setup(build) {
      build.onResolve({ filter: /^@tauri-apps\/(api\/core|plugin-sql|plugin-http)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: args.path.endsWith("plugin-sql")
        ? 'export default { load: async () => { throw new Error("Unexpected plugin load"); } };'
        : args.path.endsWith("plugin-http") ? 'export const fetch = (...args) => globalThis.__http(...args);'
        : 'export class Channel {} export const invoke = (...args) => globalThis.__invoke(...args);' }));
    } }],
  });
  globalThis.localStorage = { store: new Map(), getItem(k) { return this.store.get(k) ?? null; }, setItem(k, v) { this.store.set(k, String(v)); }, removeItem(k) { this.store.delete(k); } };
  const lib = createRequire(import.meta.url)(output);
  const { aggregateOwnership, ownershipCsv, NO_CONTRIBUTORS } = lib;
  const pass = (message) => console.log(`PASS  ${message}`);
  const token = (email) => `unmatched-email:${email}`;

  /* ── Snapshot identity ──────────────────────────────────────────────── */

  const withoutBots = (reports, groupBy, patterns = [], accounts) => {
    const contributors = lib.ownershipContributors(reports, patterns, accounts);
    return aggregateOwnership(reports, groupBy, lib.deselectContributors([], contributors, contributors.filter((c) => c.isBot)), accounts);
  };
  const alice = { name: "Alice", email: "alice@x" };
  const alias = { name: "Alias", email: "work@x" };
  const bot = { name: "robot[bot]", email: "bot@x" };
  const reports = [{ credits: [{ lines: 5, people: [alice, alias] }] }, { credits: [{ lines: 2, people: [{ name: "Alice", email: "work@x" }] }] }];
  const merged = aggregateOwnership(reports);
  assert.equal(merged.authors.length, 2, "a shared name does not join two emails without account evidence");
  assert.equal(merged.totalLines, 7);
  assert.equal(merged.creditedLines, 12, "two different people co-authoring 5 lines each receive credit");
  assert.equal(merged.authors.find((a) => a.emails.includes("work@x")).lines, 7, "the same email joins across repositories and names");
  assert.equal(aggregateOwnership(reports, "email").creditedLines, 12);
  const sameAccountCoauthors = aggregateOwnership([{ credits: [{ lines: 5, people: [
    { name: "Alex", email: "42+alex@users.noreply.github.com" }, { name: "Alex Work", email: "alex@work.com" },
  ] }] }], "person", [], new Map([["alex@work.com", { login: "alex", id: "42" }]]));
  assert.equal(sameAccountCoauthors.authors.length, 1);
  assert.equal(sameAccountCoauthors.creditedLines, 5, "author and co-author aliases of one account credit a line once");
  const bots = [{ credits: [{ lines: 3, people: [bot] }, { lines: 4, people: [bot, alice] }] }];
  assert.equal(withoutBots(bots, "person").totalLines, 4);
  assert.equal(withoutBots(bots, "person").creditedLines, 4);
  assert.equal(aggregateOwnership([]).totalLines, 0);
  const csv = ownershipCsv({ totalLines: 3, authors: [
    { author: 'Name, "Quoted"', lines: 3, share: 1, emails: ["person@example.com"] },
    { author: '=HYPERLINK("evil")', lines: 1, share: 1 / 3, emails: ["+formula@example.com"] },
  ] });
  assert.ok(csv.includes('"Name, ""Quoted""","3","1","person@example.com"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""evil"")"'));
  assert.ok(csv.includes('"\'+formula@example.com"'));
  assert.equal(merged.byRepository[1].authors[0].key, merged.authors.find((a) => a.emails.includes("work@x")).key, "charts use identities resolved across the whole selection");
  assert.equal(merged.byRepository.reduce((n, r) => n + r.totalLines, 0), merged.totalLines);
  assert.equal(merged.byRepository.reduce((n, r) => n + r.coauthoredLines, 0), merged.coauthoredLines);
  pass("email joins, namesakes kept apart, co-author deduplication per account, bot denominator, CSV escaping");

  const agentReports = [
    { credits: [{ lines: 9, people: [{ name: "Claude Fable 5", email: "noreply@anthropic.com" }, alice] },
      { lines: 4, people: [{ name: "Cursor", email: "cursoragent@cursor.com" }] }] },
    { credits: [{ lines: 1, people: [{ name: "Claude", email: "noreply@anthropic.com" }] }] },
  ];
  for (const group of ["person", "email", "name"]) {
    const filtered = withoutBots(agentReports, group, ["claude", "cursoragent"]);
    assert.equal(filtered.authors.length, 1, `${group}: configured patterns cover model-name variants and email usernames`);
    assert.equal(filtered.totalLines, 9, "human co-authored lines remain; bot-only lines leave the denominator");
    assert.equal(filtered.coauthoredLines, 0);
    assert.equal(filtered.byRepository[1].totalLines, 0);
  }
  assert.equal(withoutBots(agentReports, "person").authors.length, 3, "AI names are governed by user patterns, not guessed");
  const builtinBots = [{ credits: [
    { lines: 2, people: [{ name: "build-bot", email: "build@example.com" }] },
    { lines: 3, people: [{ name: "Automation", email: "123+dependabot[bot]@users.noreply.github.com" }] },
    { lines: 5, people: [{ name: "Abbott", email: "abbott@example.com" }] },
  ] }];
  assert.equal(withoutBots(builtinBots, "person").totalLines, 5, "a bot login from a noreply address is detected");
  const options = lib.ownershipContributors(agentReports, ["claude", "cursoragent"]);
  assert.equal(options.length, 3, "one option per resolved person");
  const humans = lib.deselectContributors([], options, options.filter((c) => c.isBot));
  assert.deepEqual(humans, [token("alice@x")], "unmatched people are selected by an internal token");
  assert.ok(options.every((o) => o.unmatched && o.label.startsWith("Unmatched: ")), "unmatched people are labelled as such");
  assert.ok(options.find((o) => o.login === token("alice@x")).searchText.includes("Alice"), "names stay searchable");
  for (const group of ["person", "email", "name"]) {
    const selected = aggregateOwnership(agentReports, group, humans);
    assert.equal(selected.totalLines, 9);
    assert.equal(selected.creditedLines, 9);
    const claude = aggregateOwnership(agentReports, group, [token("noreply@anthropic.com")]);
    assert.equal(claude.totalLines, 10, "one email's name variants are one person in every grouping");
    assert.equal(aggregateOwnership(agentReports, group, ["Claude"]).totalLines, 0, "a bare Git name is not a login");
  }
  assert.deepEqual(lib.deselectContributors([NO_CONTRIBUTORS], options, []), [NO_CONTRIBUTORS]);
  assert.equal(aggregateOwnership(agentReports, "person", [NO_CONTRIBUTORS]).totalLines, 0, "NO_CONTRIBUTORS selects nobody");
  assert.equal(aggregateOwnership(agentReports, "person", []).totalLines, 14, "All contributors restores bot credit too");
  assert.equal(aggregateOwnership(agentReports, "person", ["missing-user"]).totalLines, 0, "unmatched saved selections never fall back to All");
  pass("shared selector tokens, bot deselection, NO_CONTRIBUTORS, empty and stale selections");

  const githubReports = [{ credits: [
    { lines: 6, people: [{ name: "Alice Smith", email: "123+alice-dev@users.noreply.github.com" }] },
    { lines: 3, people: [{ name: "Alice Smith", email: "alice@company.com" }, bot] },
  ] }];
  assert.equal(lib.ownershipContributors(githubReports).find((c) => !c.isBot && !c.unmatched).login, "alice-dev");
  for (const group of ["person", "email", "name"]) {
    assert.equal(aggregateOwnership(githubReports, group, ["ALICE-DEV"]).totalLines, 6, "a login selects its account, not a namesake email");
  }
  const sameAccount = aggregateOwnership([{ credits: [
    { lines: 5, people: [{ name: "Nate Higgins", email: "nathggns@users.noreply.github.com" }] },
    { lines: 11, people: [{ name: "nathggns", email: "719814+nathggns@users.noreply.github.com" }] },
    { lines: 2, people: [{ name: "Old", email: "719814+oldlogin@users.noreply.github.com" }] },
  ] }]);
  assert.equal(sameAccount.authors.length, 1, "noreply spellings and a renamed login of one account are one person");
  assert.equal(sameAccount.authors[0].author, "nathggns");
  assert.equal(sameAccount.authors[0].lines, 18);
  assert.equal(aggregateOwnership([{ credits: [
    { lines: 5, people: [{ name: "x", email: "nate@users.noreply.github.com" }] },
  ] }]).authors[0].author, "nate", "an ID-less noreply login is provisional but still a login");
  const accounts = new Map([
    ["aaronconway796@gmail.com", { login: "aaronconway7", id: "15988654" }],
    ["bert@hotmail.com", { login: "peakman18", id: "32281438" }],
    ["bertdec@hotmail.com", { login: "bodcrop", id: "29414131" }],
    ["ada@x.com", { login: "newlogin", id: "5" }],
  ]);
  const resolvedReports = [{ credits: [
    { lines: 10, people: [{ name: "Aaron Conway", email: "aaronconway796@gmail.com" }] },
    { lines: 2, people: [{ name: "aaronconway7", email: "15988654+aaronconway7@users.noreply.github.com" }] },
    { lines: 4, people: [{ name: "Bert Decrop", email: "bert@hotmail.com" }] },
    { lines: 3, people: [{ name: "bodcrop", email: "bertdec@hotmail.com" }] },
    { lines: 1, people: [{ name: "Local", email: "local@host" }] },
  ] }];
  const resolved = aggregateOwnership(resolvedReports, "person", [], accounts);
  assert.equal(resolved.authors.length, 4);
  assert.equal(resolved.authors.find((a) => a.author === "aaronconway7").lines, 12);
  assert.equal(resolved.authors.find((a) => a.author === "peakman18").lines, 4);
  assert.equal(resolved.authors.find((a) => a.author === "Unmatched: Local").lines, 1);
  assert.equal(aggregateOwnership(resolvedReports, "email", [], accounts).authors.length, 5, "email grouping keeps raw identities");
  assert.equal(aggregateOwnership(resolvedReports, "person", ["aaronconway7"], accounts).totalLines, 12);
  assert.equal(lib.ownershipContributors(resolvedReports, [], accounts).find((c) => c.login === "aaronconway7").commits, 12);
  const renamed = aggregateOwnership([{ credits: [
    { lines: 9, people: [{ name: "Ada", email: "ada@x.com" }] },
    { lines: 1, people: [{ name: "oldlogin", email: "5+oldlogin@users.noreply.github.com" }] },
  ] }], "person", [], accounts);
  assert.equal(renamed.authors.length, 1);
  assert.equal(renamed.authors[0].author, "newlogin");
  assert.equal(aggregateOwnership([{ credits: [{ lines: 9, people: [{ name: "Ada", email: "ada@x.com" }] }] }], "person", ["oldlogin"],
    lib.buildAccountIndex({ accounts: accounts.entries(), users: [{ id: "5", login: "newlogin", logins: ["oldlogin"] }] })).totalLines, 9,
  "a saved former login still selects the account");
  const matched = lib.githubUserForCommit({
    author: { login: "aaronconway7", id: 15988654 }, committer: { login: "other", id: 9 },
    commit: { author: { email: "aaronconway796@gmail.com" }, committer: { email: "other@x.com" } },
  }, { email: "aaronconway796@gmail.com", role: "author" });
  assert.deepEqual(matched.account, { login: "aaronconway7", id: "15988654" });
  assert.equal(lib.githubUserForCommit({
    author: { login: "aaronconway7", id: 15988654 }, committer: { login: "other", id: 9 },
    commit: { author: { email: "aaronconway796@gmail.com" }, committer: { email: "other@x.com" } },
  }, { email: "other@x.com", role: "author" }).matched, false);
  pass("GitHub IDs, noreply spellings, renames, commits-API matches and account selections");

  /* ── The plan's identity examples ───────────────────────────────────── */

  const manualRow = (over) => ({ mappingId: 1, matchKind: "email", matchValue: "", repoId: null, githubId: "42", loginAtSave: "alex", reviewedAutoConflict: false, ...over });
  const alexUsers = [{ id: "42", login: "alex", logins: ["oldalex"] }, { id: "99", login: "other" }];
  const idx = (over = {}) => lib.buildAccountIndex({
    accounts: [["a1@x", { login: "alex", id: "42" }], ["a2@x", { login: "oldalex", id: "42" }], ["smith@b", { login: "other", id: "99" }], ...(over.accounts ?? [])],
    users: alexUsers, observations: over.observations, manual: over.manual,
  });
  const rep = (...credits) => [{ credits: credits.map(([lines, ...people]) => ({ lines, people })) }];
  const A1 = { name: "Alex Smith", email: "a1@x" };
  const A2 = { name: "Alex", email: "a2@x" };
  const S = { name: "Alex Smith", email: "smith@b" };
  const U = { name: "Alex", email: "alex@home" };
  let r = aggregateOwnership(rep([3, A1], [4, A2]), "person", ["alex"], idx());
  assert.equal(r.authors.length, 1); assert.equal(r.authors[0].author, "alex"); assert.equal(r.totalLines, 7);
  assert.equal(aggregateOwnership(rep([3, A1], [4, A2]), "person", ["OLDALEX"], idx()).totalLines, 7, "former login");
  r = aggregateOwnership(rep([3, A1], [5, S]), "person", [], idx());
  assert.equal(r.authors.length, 2, "same name, two IDs: two accounts");
  assert.equal(aggregateOwnership(rep([3, A1], [5, S]), "person", ["alex"], idx()).totalLines, 3);
  assert.equal(aggregateOwnership(rep([3, A1], [2, U]), "person", ["alex"], idx()).totalLines, 3, "unmatched namesake is not selected");
  const manualIdx = idx({ manual: [manualRow({ matchValue: "alex@home" })] });
  assert.equal(aggregateOwnership(rep([3, A1], [2, U]), "person", ["alex"], manualIdx).totalLines, 5, "manual mapping joins the account");
  assert.deepEqual(aggregateOwnership(rep([3, A1], [2, U]), "person", [], manualIdx).authors[0].sources, ["github", "manual"]);
  const superseded = idx({ manual: [manualRow({ matchValue: "alex@home" })], accounts: [["alex@home", { login: "other", id: "99" }]] });
  assert.equal(aggregateOwnership(rep([2, U]), "person", ["other"], superseded).totalLines, 2, "automatic evidence wins over manual");
  r = aggregateOwnership(rep([6, A1, A2]), "person", [], idx());
  assert.equal(r.creditedLines, 6, "author and co-author of one account: one credit");
  r = aggregateOwnership(rep([6, A1, S]), "person", [], idx());
  assert.equal(r.totalLines, 6); assert.equal(r.creditedLines, 12, "two accounts on one line: credit exceeds physical lines");
  assert.equal(aggregateOwnership(rep([6, A1, S]), "person", [NO_CONTRIBUTORS], idx()).authors.length, 0);
  const conflict = idx({ observations: [{ email: "c@x", id: "42" }, { email: "c@x", id: "99" }] });
  const C = { name: "Conflicted", email: "c@x" };
  assert.equal(aggregateOwnership(rep([2, C]), "person", [], conflict).authors[0].matched, false, "conflicting automatic evidence stays unresolved");
  assert.equal(lib.resolveIdentity(C, conflict).conflict, true);
  const unreviewed = idx({ observations: [{ email: "c@x", id: "42" }, { email: "c@x", id: "99" }], manual: [manualRow({ matchValue: "c@x" })] });
  assert.equal(lib.resolveIdentity(C, unreviewed).source, "unmatched", "a manual choice needs the conflict reviewed");
  const reviewed = idx({ observations: [{ email: "c@x", id: "42" }, { email: "c@x", id: "99" }], manual: [manualRow({ matchValue: "c@x", reviewedAutoConflict: true })] });
  assert.equal(lib.resolveIdentity(C, reviewed).key, "github:42");
  const nameOnly = idx({ manual: [manualRow({ matchKind: "repo_name", matchValue: "Build Box", repoId: 7 })] });
  const N = { name: "build  box", email: "" };
  assert.equal(lib.resolveIdentity({ ...N, repoId: 7 }, nameOnly).key, "github:42", "a name-only mapping applies in its repository");
  assert.equal(lib.resolveIdentity({ ...N, repoId: 8 }, nameOnly).source, "unmatched", "and nowhere else");
  assert.equal(lib.resolveIdentity({ name: "Build Box", email: "b@x", repoId: 7 }, nameOnly).source, "unmatched", "and never to an identity with an email");
  assert.notEqual(lib.unmatchedKey({ ...N, repoId: 7 }), lib.unmatchedKey({ ...N, repoId: 8 }), "email-less identities are scoped per repository");
  pass("identity examples: one ID one login, renames, namesakes, manual map, supersession, conflicts, co-authors, NO_CONTRIBUTORS");

  const inventory = lib.mappingInventory([
    { repoId: 1, report: rep([3, U], [2, U, A1])[0], legacyHistory: false },
    { repoId: 2, report: rep([4, { name: "A. Home", email: "alex@home" }], [1, C])[0], legacyHistory: true },
  ], idx({ observations: [{ email: "c@x", id: "42" }, { email: "c@x", id: "99" }] }));
  const home = inventory.find((row) => row.email === "alex@home");
  assert.equal(home.status, "unmatched");
  assert.equal(home.identities, 2);
  assert.equal(home.lines, 9);
  assert.deepEqual(home.repoIds, [1, 2]);
  assert.equal(home.historyResolved, false, "legacy history is flagged");
  assert.deepEqual(lib.mappingPreview(inventory, { kind: "email", value: "alex@home", repoId: null }), { identities: 2, lines: 9, repositories: 2 });
  assert.equal(inventory.find((row) => row.email === "c@x").status, "conflict");
  assert.equal(lib.mappingInventory([{ repoId: 1, report: rep([2, U])[0], legacyHistory: false }], superseded)[0].status, "superseded");
  pass("Settings inventory, mapping preview, superseded and conflicting rows");

  /* ── History ────────────────────────────────────────────────────────── */

  const historyAuthor = (author, email, lines, names = [author]) => ({ author, names, emails: [email], lines });
  const aliceHistory = (lines) => historyAuthor("Alice", "alice@x", lines);
  const aliceToken = [token("alice@x")];
  const gap = lib.ownershipHistorySeries([
    { repoId: 1, committedAt: "2020-01-01T00:00:00Z", authors: [aliceHistory(3)] },
    { repoId: 1, committedAt: "2020-01-03T00:00:00Z", authors: [aliceHistory(5)] },
  ], []);
  assert.equal(gap.data.length, 3, "missing days stay on the chart");
  assert.equal(gap.data[1][gap.series[0].key], 3, "a day without a commit keeps the previous total");
  assert.equal(gap.data[2][gap.series[0].key], 5);
  const sameDay = lib.ownershipHistorySeries([
    { repoId: 1, committedAt: "2020-01-02T00:30:00Z", authors: [aliceHistory(1)] },
    { repoId: 1, committedAt: "2020-01-01T20:30:00-05:00", authors: [aliceHistory(8)] },
  ], []);
  assert.equal(sameDay.data.length, 1);
  assert.equal(sameDay.data[0][sameDay.series[0].key], 8, "the later commit of the UTC day wins");
  const selected = lib.ownershipHistorySeries([{ repoId: 1, committedAt: "2020-01-02T00:00:00Z",
    authors: [aliceHistory(4), historyAuthor("Bob", "bob@x", 6)] }], aliceToken);
  assert.equal(selected.series.length, 1);
  assert.equal(selected.data[0][selected.series[0].key], 4);
  assert.equal(lib.ownershipHistorySeries([{ repoId: 1, committedAt: "2020-01-02T00:00:00Z", authors: [aliceHistory(4)] }], ["Alice"]).series.length, 0, "a bare name selects nobody");
  assert.equal(lib.ownershipHistorySeries([{ repoId: 1, committedAt: "2020-01-02T00:00:00Z", authors: [aliceHistory(4)] }], [NO_CONTRIBUTORS]).series.length, 0);
  const nine = Array.from({ length: 9 }, (_, i) => historyAuthor(`Person ${String(i).padStart(2, "0")}`, `p${i}@x`, 20 - i));
  const folded = lib.ownershipHistorySeries([{ repoId: 1, committedAt: "2020-01-02T00:00:00Z", authors: nine }], []);
  assert.equal(folded.series.length, 9);
  assert.equal(folded.series[8].key, "other");
  assert.equal(folded.data[0].other, 12, "the ninth person is Other");
  const summed = lib.ownershipHistorySeries([
    { repoId: 1, committedAt: "2020-01-02T00:00:00Z", authors: [historyAuthor("Alice", "alice@x", 3)] },
    { repoId: 2, committedAt: "2020-01-02T12:00:00Z", authors: [historyAuthor("A.", "alice@x", 4, ["A."])] },
    { repoId: 2, committedAt: "2020-01-04T00:00:00Z", authors: [historyAuthor("Alice Smith", "other@x", 1, ["Alice Smith"])] },
  ], []);
  assert.equal(summed.series.length, 2);
  assert.equal(summed.data[0][summed.series[0].key], 7, "the same email sums across repositories");
  const sharedName = lib.ownershipHistorySeries([
    { repoId: 1, committedAt: "2020-01-02T00:00:00Z", authors: [historyAuthor("Alice", "a@x", 2, ["Alice Smith"])] },
    { repoId: 2, committedAt: "2020-01-02T00:00:00Z", authors: [historyAuthor("Alice Smith", "b@x", 3, ["Alice Smith"])] },
  ], []);
  assert.equal(sharedName.series.length, 2, "a shared name no longer merges people across repositories");
  const sameGithubAccount = lib.ownershipHistorySeries([{ repoId: 1, committedAt: "2020-01-02T00:00:00Z", authors: [
    historyAuthor("Nate Higgins", "nathggns@users.noreply.github.com", 5),
    historyAuthor("nathggns", "719814+nathggns@users.noreply.github.com", 11),
  ] }], []);
  assert.equal(sameGithubAccount.series.length, 1);
  assert.equal(sameGithubAccount.series[0].label, "nathggns");
  assert.equal(sameGithubAccount.data[0][sameGithubAccount.series[0].key], 16);
  const resolvedHistory = lib.ownershipHistorySeries([{ repoId: 1, committedAt: "2020-01-02T00:00:00Z", authors: [
    historyAuthor("Aaron Conway", "aaronconway796@gmail.com", 10),
    historyAuthor("aaronconway7", "15988654+aaronconway7@users.noreply.github.com", 2),
    historyAuthor("Bert Decrop", "bert@hotmail.com", 4),
  ] }], [], { accounts });
  assert.equal(resolvedHistory.series.length, 2);
  assert.equal(resolvedHistory.data[0][resolvedHistory.series.find((s) => s.label === "aaronconway7").key], 12);
  const four = lib.ownershipHistorySeries([{ repoId: 1, committedAt: "2020-01-02T00:00:00Z", authors: nine }], [], { limit: 4 });
  assert.equal(four.data[0].other, 70);
  const everyone = lib.ownershipHistorySeries([{ repoId: 1, committedAt: "2020-01-02T00:00:00Z", authors: nine }], [], { limit: Infinity });
  assert.equal(everyone.series.length, 9, "All is every series, never silently folded");
  const byRepo = lib.ownershipHistorySeries([
    { repoId: 1, committedAt: "2020-01-02T00:00:00Z", authors: [aliceHistory(3)] },
    { repoId: 2, committedAt: "2020-01-02T00:00:00Z", authors: [historyAuthor("A.", "alice@x", 4, ["A."])] },
  ], [], { split: "repository", repoNames: new Map([[1, "org/one"], [2, "org/two"]]) });
  assert.deepEqual(byRepo.series.map((s) => s.label).sort(), ["org/one", "org/two"]);
  pass("legacy history: carry-forward, daily collapse, selection, Other, All, repository split, account joins");

  const raw = (repoId, identities, days) => ({ repoId, legacy: false, identities: new Map(identities.map((p, i) => [i, p])), days });
  const rawDays = raw(1, [A1, A2, S, U], [
    { committedAt: "2020-01-01T10:00:00Z", revision: "a", groups: [[[0, 1], 6], [[2], 4]] },
    { committedAt: "2020-01-03T10:00:00Z", revision: "b", groups: [[[0, 1], 2], [[2], 4], [[3], 5]] },
  ]);
  const people = lib.ownershipHistorySeries([rawDays], [], { accounts: idx() });
  const alexKey = people.series.find((s) => s.label === "alex").key;
  assert.equal(people.data[0][alexKey], 6, "an author and co-author of one account are credited once per line");
  assert.equal(people.data[2][alexKey], 2, "and lose lines as they are replaced");
  const mapped = lib.ownershipHistorySeries([rawDays], [], { accounts: manualIdx });
  assert.equal(mapped.data[2][mapped.series.find((s) => s.label === "alex").key], 7, "a manual mapping reprojects raw history without Git");
  const total = lib.ownershipHistorySeries([rawDays], ["alex"], { accounts: idx(), split: "total" });
  assert.deepEqual(total.data.map((row) => row.total), [6, 6, 2], "total counts physical lines with a selected person");
  const ordered = (ids) => {
    const other = raw(2, [U, A1], [{ committedAt: "2020-01-02T00:00:00Z", groups: [[[0], 3], [[1], 1]] }]);
    const histories = ids.map((id) => (id === 1 ? rawDays : other));
    return JSON.stringify(lib.ownershipHistorySeries(histories, [], { accounts: idx(), limit: Infinity }));
  };
  assert.equal(ordered([1, 2]), ordered([2, 1]), "repository order does not change the result");
  const moving = lib.ownershipHistorySeries([
    raw(1, [A1], [{ committedAt: "2020-01-01T00:00:00Z", groups: [[[0], 10]] }, { committedAt: "2020-01-02T00:00:00Z", groups: [] }]),
    raw(2, [A1, S], [{ committedAt: "2020-01-01T00:00:00Z", groups: [[[1], 9]] }, { committedAt: "2020-01-02T00:00:00Z", groups: [[[0], 10], [[1], 9]] }]),
  ], [], { accounts: idx(), limit: 1 });
  assert.equal(moving.series[0].label, "alex", "peak-day ranking");
  assert.deepEqual(moving.data.map((row) => row[moving.series[0].key]), [10, 10], "lines moving between repositories on one day are not a transient peak");
  const levels = moving.data;
  const perPeriod = lib.ownershipHistoryBuckets([{ week: 0, a: 5 }, { week: 86400, a: 2 }, { week: 172800, a: 9 }], ["a"], "day", "period");
  assert.deepEqual(perPeriod.map((row) => row.a), [5, -3, 7], "per-period changes, including negatives");
  assert.ok(levels.length === 2);
  pass("raw history: co-author dedupe after resolution, manual reprojection, total split, order independence, peaks, negatives");

  const seconds = (iso) => Date.parse(iso) / 1000;
  const stock = [
    { week: seconds("2020-01-01T00:00:00Z"), a: 2 },
    { week: seconds("2020-01-04T00:00:00Z"), a: 5 },
    { week: seconds("2020-01-05T00:00:00Z"), a: 8 },
    { week: seconds("2020-01-31T00:00:00Z"), a: 9 },
    { week: seconds("2020-02-01T00:00:00Z"), a: 4 },
  ];
  const weekly = lib.ownershipHistoryBuckets(stock, ["a"], "week", "cumulative");
  assert.deepEqual(weekly.map((row) => row.a), [5, 8, 4], "a week keeps its last day rather than summing the stock");
  assert.equal(weekly[0].week, seconds("2019-12-29T00:00:00Z"));
  assert.deepEqual(lib.ownershipHistoryBuckets(stock, ["a"], "month", "cumulative").map((row) => row.a), [9, 4]);
  assert.deepEqual(lib.ownershipHistoryBuckets(stock, ["a"], "quarter", "cumulative").map((row) => row.a), [4]);
  assert.deepEqual(lib.ownershipHistoryBuckets(stock, ["a"], "week", "period").map((row) => row.a), [5, 3, -4]);
  const daily = Array.from({ length: 10 }, (_, i) => ({ week: i * 86400, a: [1, 3, 2, 8, 4, 4, 9, 0, 5, 6][i] }));
  const changes = lib.ownershipHistoryBuckets(daily, ["a"], "day", "period");
  const coarseLevels = lib.coarsenPlotRows(daily, ["a"], 4, "cumulative");
  assert.equal(coarseLevels.factor, 3);
  assert.deepEqual(coarseLevels.rows.map((row) => row.a), [2, 4, 5, 6], "cumulative points are bucket-end levels");
  assert.equal(coarseLevels.ends.get(0), 2 * 86400, "each plotted point knows the range it covers");
  const coarseChanges = lib.coarsenPlotRows(changes, ["a"], 4, "period");
  assert.deepEqual(coarseChanges.rows.map((row) => row.a), [2, 2, 1, 1], "per-period points sum every change in their range");
  assert.equal(lib.coarsenPlotRows([{ week: 0, a: 5 }, { week: 1, a: -9 }, { week: 2, a: 1 }], ["a"], 1, "period").rows[0].a, -3, "negative changes survive coarsening");
  assert.equal(coarseChanges.rows.reduce((n, row) => n + row.a, 0), 6, "and add up to the exact total");
  assert.equal(lib.coarsenPlotRows(daily, ["a"], 100, "cumulative").rows, daily, "within budget the exact rows are plotted");
  assert.ok(lib.plotBudget(1000, "area") > lib.plotBudget(1000, "bar"));
  pass("period buckets, bounded plot rows with exact ranges and preserved per-period totals");

  /* ── Storage ────────────────────────────────────────────────────────── */

  const openDb = (path) => {
    const sqlite = new DatabaseSync(path);
    sqlites.push(sqlite);
    const named = (params) => Object.fromEntries(params.map((v, i) => [String(i + 1), v ?? null]));
    const state = { failOn: null, reads: 0 };
    const db = {
      state, sqlite,
      select: async (sql, params = []) => {
        const rows = sqlite.prepare(sql).all(named(params));
        // Count snapshot text that actually crosses into JavaScript.
        state.reads += rows.filter((row) => typeof row.snapshot === "string" && row.snapshot.length > 0).length;
        return rows;
      },
      execute: async (sql, params = []) => {
        assert.ok(!/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql), "no multi-call transactions");
        if (state.failOn && state.failOn.test(sql)) throw new Error("disk failure");
        const result = sqlite.prepare(sql).run(named(params));
        return { rowsAffected: Number(result.changes) };
      },
    };
    return db;
  };

  // A version 7 database, as the previous release left it.
  const oldPath = join(work, "v7.sqlite");
  const old = new DatabaseSync(oldPath);
  old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES ('schema_version', '7');
    CREATE TABLE line_ownership (repo_id INTEGER PRIMARY KEY, revision TEXT, calculated_at TEXT NOT NULL, checked_at TEXT NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE github_accounts (email TEXT PRIMARY KEY, login TEXT, github_id TEXT);
    INSERT INTO github_accounts VALUES ('a1@x', 'oldalex', '42'), ('miss@x', NULL, NULL);
    CREATE TABLE line_ownership_history (repo_id INTEGER NOT NULL, revision TEXT NOT NULL, committed_at TEXT NOT NULL, total_lines INTEGER NOT NULL, coauthored_lines INTEGER NOT NULL, authors_json TEXT NOT NULL, PRIMARY KEY (repo_id, revision));
    INSERT INTO line_ownership_history VALUES (1, 'x', '2020-01-01T00:00:00Z', 3, 0, '[{"author":"Alice","names":["Alice"],"emails":["alice@x"],"lines":3}]');`);
  old.close();
  const migrated = openDb(oldPath);
  await lib.migrate(migrated);
  await lib.migrate(migrated);
  const columns = (table) => migrated.sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  assert.ok(["report", "metadata", "cache_ref"].every((c) => columns("line_ownership").includes(c)), "snapshot columns added");
  assert.ok(columns("github_accounts").includes("checked_at"));
  assert.equal(migrated.sqlite.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(lib.SCHEMA_VERSION));
  assert.equal(migrated.sqlite.prepare("SELECT login FROM github_users WHERE github_id = '42'").get().login, "oldalex", "the registry is backfilled");
  assert.equal(migrated.sqlite.prepare("SELECT COUNT(*) AS n FROM line_ownership_history").get().n, 1, "legacy history is kept");
  const legacyRevision = await lib.ownershipRevisions(migrated, [1]);
  assert.equal(legacyRevision.length, 0, "no repos row, no revision");
  pass("idempotent migration from version 7 keeps legacy history and backfills the account registry");

  const db = openDb(join(work, "test.sqlite"));
  await lib.migrate(db);
  const revision0 = await lib.ownershipAccountRevision(db);
  await lib.writeGithubAccounts(db, [["a1@x", "oldalex", "42"], ["c@x", "alex", "42"], ["miss@x", null, null]]);
  const revision1 = await lib.ownershipAccountRevision(db);
  assert.notEqual(revision0, revision1, "account writes bump the revision in the same statement");
  await lib.writeGithubAccounts(db, [["c@x", "other", "99"]]);
  let index = await lib.ownershipAccountIndex(db);
  assert.deepEqual(index.conflicts.get("c@x"), ["42", "99"], "a changed answer is a visible conflict");
  await lib.writeGithubUserLookup(db, "42", "alex");
  await lib.writeGithubAccounts(db, [["a1@x", "oldalex", "42"]]);
  index = await lib.ownershipAccountIndex(db);
  assert.equal(index.users.get("42").login, "alex", "a login read back by ID is not overwritten by an older commit match");
  assert.ok(index.users.get("42").logins.includes("oldalex"));
  assert.equal(lib.resolveIdentity({ name: "x", email: "a1@x" }, index).key, "github:42");
  db.sqlite.exec("INSERT INTO contributors (login, gh_id) VALUES ('Alex', 42)");
  assert.notEqual(await lib.ownershipAccountRevision(db), revision1, "contributor logins are part of the revision");
  assert.deepEqual(await lib.staleGithubUsers(db, new Date(Date.now() - 60_000).toISOString(), 10), ["99"], "only logins not read back recently are refreshed");
  const knownNow = await lib.knownGithubAccountEmails(db, ["a1@x", "miss@x", "new@x"]);
  assert.deepEqual([...knownNow].sort(), ["a1@x", "miss@x"]);
  const settled = await lib.knownGithubAccountEmails(db, ["a1@x", "miss@x"], "9999-01-01");
  assert.deepEqual([...settled], ["a1@x"], "an old miss is asked about again");

  const manualRevision = await lib.ownershipAccountRevision(db);
  await lib.saveManualMapping(db, { matchKind: "email", matchValue: " Alex@Home ", repoId: null, githubId: "42", loginAtSave: "alex", reviewedAutoConflict: false });
  await lib.saveManualMapping(db, { matchKind: "email", matchValue: "alex@home", repoId: null, githubId: "99", loginAtSave: "other", reviewedAutoConflict: false });
  await lib.saveManualMapping(db, { matchKind: "repo_name", matchValue: "Build Box", repoId: 7, githubId: "42", loginAtSave: "alex", reviewedAutoConflict: false });
  await lib.saveManualMapping(db, { matchKind: "repo_name", matchValue: "Build Box", repoId: 8, githubId: "99", loginAtSave: "other", reviewedAutoConflict: false });
  await assert.rejects(lib.saveManualMapping(db, { matchKind: "repo_name", matchValue: "x", repoId: null, githubId: "1", loginAtSave: "x", reviewedAutoConflict: false }));
  await assert.rejects(lib.saveManualMapping(db, { matchKind: "email", matchValue: "x@x", repoId: null, githubId: "alex", loginAtSave: "alex", reviewedAutoConflict: false }), /verified/);
  let mappings = await lib.listManualMappings(db);
  assert.equal(mappings.length, 3, "editing an email mapping replaces it; name mappings are per repository");
  assert.equal(mappings.find((m) => m.matchKind === "email").githubId, "99");
  assert.notEqual(await lib.ownershipAccountRevision(db), manualRevision, "mapping edits bump the revision");
  index = await lib.ownershipAccountIndex(db);
  assert.equal(lib.resolveIdentity({ name: "", email: "alex@home" }, index).key, "github:99");
  assert.equal(lib.resolveIdentity({ name: "build box", email: "", repoId: 8 }, index).key, "github:99");
  await lib.deleteManualMapping(db, mappings.find((m) => m.matchKind === "email").mappingId);
  index = await lib.ownershipAccountIndex(db);
  assert.equal(lib.resolveIdentity({ name: "", email: "alex@home" }, index).source, "unmatched", "removing a mapping restores unmatched");
  await lib.clearAnalytics(db);
  assert.equal((await lib.listManualMappings(db)).length, 2, "clearing the analytics cache keeps manual mappings");
  assert.equal((await lib.ownershipAccountIndex(db)).users.size, 1, "the registry is cache and is cleared; Contributors logins remain");
  pass("account registry, conflicts, renames by ID, retryable misses, manual mapping create/edit/delete and revisions");

  db.sqlite.exec("INSERT INTO repos (id, owner, name, full_name) VALUES (1, 'org', 'one', 'org/one'), (2, 'org', 'two', 'org/two')");
  const point = (revision, committedAt, lines, groups = [[[0], lines]]) => ({ revision, committedAt, totalLines: lines, coauthoredLines: 0, groups });
  const batch = (points, over = {}) => ({ needsReset: false, identities: [[0, "Alice", "alice@x"]], points, cursor: points.at(-1)?.revision ?? null,
    checkpointRef: `ck-${Math.random()}`, done: false, completed: points.length, total: 9, final: null, engine: "blame", ...over });
  db.sqlite.exec(`INSERT INTO line_ownership_history VALUES (1, 'legacy', '2020-01-01T00:00:00Z', 1, 0, '[{"author":"Alice","names":["Alice"],"emails":["alice@x"],"lines":1}]')`);
  let gen = await lib.beginHistoryGeneration(db, 1, "blame");
  assert.equal(gen, 1);
  assert.equal((await lib.ownershipRevisions(db, [1]))[0].history.kind, "legacy", "legacy rows stay visible while a generation builds");
  const first = batch([point("aa", "2020-01-02T10:00:00Z", 4)]);
  assert.equal(await lib.writeHistoryBatch(db, 1, gen, "ff", first), true);
  db.state.failOn = /UPDATE line_ownership_history_gen/;
  await assert.rejects(lib.writeHistoryBatch(db, 1, gen, "ff", batch([point("bb", "2020-01-03T10:00:00Z", 5)])));
  db.state.failOn = null;
  assert.equal((await lib.historyGenState(db, 1)).cursor, "aa", "a crash before the pointer update leaves the old cursor");
  assert.equal(await lib.writeHistoryBatch(db, 1, gen, "ff", batch([point("bb", "2020-01-03T10:00:00Z", 5)])), true, "the retry is idempotent");
  const done = batch([point("ff", "2020-01-03T09:00:00Z", 6)], { done: true });
  assert.equal(await lib.writeHistoryBatch(db, 1, gen, "ff", done, { verified: true }), true);
  let rev = (await lib.ownershipRevisions(db, [1]))[0];
  assert.deepEqual(rev.history, { kind: "generation", generation: 1, partial: false });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM line_ownership_history WHERE repo_id = 1").get().n, 0, "legacy rows go once a generation is visible");
  let days = await lib.ownershipDays(db, 1, rev.history);
  assert.deepEqual(days.days.map((d) => d.revision), ["aa", "bb"], "an earlier commit time on the same day does not replace the winner");
  assert.equal(await lib.ownershipHistoryCovers(db, 1, "ff"), true);
  gen = await lib.beginHistoryGeneration(db, 1, "replay");
  assert.equal(gen, 2);
  await lib.writeHistoryBatch(db, 1, gen, "ff", batch([point("zz", "2021-01-01T00:00:00Z", 1)]));
  rev = (await lib.ownershipRevisions(db, [1]))[0];
  assert.equal(rev.history.generation, 1, "the previous generation stays visible during a rebuild");
  assert.equal(rev.historyRevision, "g1", "and its cache key does not change while the rebuild writes");
  await lib.writeHistoryBatch(db, 1, gen, "ff", batch([], { done: true }), { verified: false, error: "mismatch" });
  rev = (await lib.ownershipRevisions(db, [1]))[0];
  assert.equal(rev.history.generation, 1, "an unverified generation is never shown");
  assert.equal(rev.historyStatus, "failed");
  assert.equal(await lib.writeHistoryBatch(db, 1, 1, "ff", batch([])), false, "a stale generation cannot write its pointer");
  gen = await lib.beginHistoryGeneration(db, 1, "blame");
  await lib.writeHistoryBatch(db, 1, gen, "ff", batch([point("ff", "2020-01-03T09:00:00Z", 6)], { done: true }), { verified: true });
  assert.equal(db.sqlite.prepare("SELECT COUNT(DISTINCT generation) AS n FROM line_ownership_day WHERE repo_id = 1").get().n, 1, "old generations are collected");
  pass("history generations: legacy stays visible, crash-safe idempotent batches, verified switch, failed rebuilds keep the old chart");

  // The day upsert must choose exactly what the legacy query chose, for any order and batching.
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const commits = Array.from({ length: 160 }, (_, i) => {
    const base = Date.parse("2020-03-01T00:00:00Z") + Math.floor(rand() * 20) * 86_400_000 + Math.floor(rand() * 4) * 3600_000;
    const offset = ["Z", "+02:00", "-05:00"][Math.floor(rand() * 3)];
    const shifted = new Date(base + (offset === "Z" ? 0 : offset === "+02:00" ? 7200_000 : -18000_000)).toISOString().slice(0, 19);
    return point(`${String(i).padStart(3, "0")}${"c".repeat(37)}`.slice(0, 40), `${shifted}${offset}`, i + 1);
  });
  for (const c of commits) db.sqlite.prepare("INSERT INTO line_ownership_history VALUES (2, ?, ?, ?, 0, ?)").run(c.revision, c.committedAt, c.totalLines, JSON.stringify([{ author: "A", names: ["A"], emails: ["a@x"], lines: c.totalLines }]));
  const utcDay = (iso) => new Date(Date.parse(iso)).toISOString().slice(0, 10);
  const expected = (await lib.ownershipHistory(db, [2])).map((p) => `${utcDay(p.committedAt)}:${p.authors[0].lines}`);
  const genEq = await lib.beginHistoryGeneration(db, 2, "blame");
  const shuffled = [...commits].sort(() => rand() - 0.5);
  for (let i = 0; i < shuffled.length; i += 17) await lib.writeHistoryBatch(db, 2, genEq, "t", batch(shuffled.slice(i, i + 17)));
  for (let i = 0; i < 40; i += 13) await lib.writeHistoryBatch(db, 2, genEq, "t", batch(shuffled.slice(i, i + 13)));
  const got = (await lib.ownershipDays(db, 2, { kind: "generation", generation: genEq, partial: true })).days
    .map((d) => `${utcDay(d.committedAt)}:${d.groups[0][1]}`);
  assert.deepEqual(got, [...expected].sort(), "same winner per UTC day as the legacy query");
  assert.equal(got.length, new Set(commits.map((c) => utcDay(c.committedAt))).size);
  pass("daily winner upsert reproduces the saved-history rule for out-of-order, offset and retried writes");

  /* ── Sync protocol ──────────────────────────────────────────────────── */

  const repos = [1, 2, 3].map((id) => ({ id, name: `repo${id}`, full_name: `org/repo${id}`, archived: id === 3,
    size: 10, pushed_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-01T00:00:00Z" }));
  const sdb = openDb(join(work, "sync.sqlite"));
  await lib.migrate(sdb);
  globalThis.__http = async (url) => {
    assert.ok(String(url).includes("/orgs/org/repos"), String(url));
    return new Response(JSON.stringify(repos), { status: 200, headers: { "content-type": "application/json" } });
  };
  const options0 = { repo: "/fixture", revision: "HEAD", groupBy: "person", pathspecs: [], excludes: [], includeGenerated: false, ignoreWhitespace: true, excludeBots: false };
  const report = (revision, lines = 3) => ({ revision, repo: "org/repo", options: options0, credits: [{ lines, people: [alice] }], totalLines: lines, creditedLines: lines,
    coauthoredLines: 0, filesBlamed: 1, filesSkipped: {}, filesReused: 1, filesRecalculated: 0, authors: [] });
  let refs = 0;
  let revision = "a".repeat(40);
  let scans = [];
  let walks = [];
  let preparations = 0;
  let activePreparations = 0;
  let maxPreparations = 0;
  let finalLines = 3;
  let resetOnce = false;
  const setScanner = (scan) => {
    globalThis.__invoke = async (command, args) => {
      if (command === "prepare_line_ownership") {
        assert.equal(args.token, "fixture-token");
        preparations++;
        activePreparations++;
        maxPreparations = Math.max(maxPreparations, activePreparations);
        await new Promise((r) => setTimeout(r, 5));
        activePreparations--;
        return { revision, unchanged: args.metadata?.revision === revision };
      }
      if (command === "line_ownership_account_samples") return [];
      if (command === "cancel_line_ownership") return;
      if (command === "advance_line_ownership_history") {
        walks.push(args);
        if (resetOnce && args.checkpointRef) { resetOnce = false; return { needsReset: true, identities: [], points: [], done: false, completed: 0, total: 0 }; }
        return batch([point(args.revision, "2020-01-02T00:00:00Z", 3)], {
          done: true, completed: 1, total: 1, checkpointRef: `ck-${++refs}`, engine: args.engine,
          final: { totalLines: finalLines, groups: [[[["Alice", "alice@x"]], finalLines]] },
        });
      }
      return scan(command, args);
    };
  };
  const scanner = async (command, args) => {
    assert.equal(command, "sync_line_ownership");
    scans.push(args);
    return { report: JSON.stringify(report(args.revision)), metadata: JSON.stringify({ version: 2, revision: args.revision, options: options0 }), cacheRef: `head-${++refs}` };
  };
  setScanner(scanner);
  const syncOptions = { db: sdb, token: "fixture-token", org: "org", endpoints: ["line_ownership"], repoIds: [1, 2, 3] };
  await lib.runSync(syncOptions);
  assert.equal(maxPreparations, 2, "both repositories prepare concurrently");
  assert.equal(scans.length, 2, "every selected non-archived repository is scanned");
  assert.ok(scans.every((s) => s.previousRef === null && s.previousJson === null));
  assert.equal(walks.length, 2);
  assert.ok(walks.every((w) => w.checkpointRef === null && w.generation === 1 && w.engine === "replay"), "replay is the default engine");
  let rows = await lib.ownershipRevisions(sdb, [1, 2, 3]);
  assert.deepEqual(rows.map((r) => r.hasReport), [true, true, false], "missing snapshots stay visible");
  assert.ok(rows.slice(0, 2).every((r) => r.history.kind === "generation" && !r.history.partial));
  assert.equal((await lib.ownershipReport(sdb, 1)).totalLines, 3);
  const saved = await lib.ownershipCheckpoint(sdb, 1);
  assert.match(saved.cacheRef, /^head-/, "the database holds a native cache reference, not the file cache");
  assert.equal(saved.legacyJson, null);
  scans = []; walks = [];
  await lib.runSync({ ...syncOptions, mode: "resume" });
  assert.equal(scans.length + walks.length, 0, "resume skips completed repositories");
  sdb.sqlite.exec("UPDATE line_ownership SET calculated_at = '2020-01-01T00:00:00Z'");
  preparations = 0;
  sdb.state.reads = 0;
  await lib.runSync(syncOptions);
  assert.equal(preparations, 2, "incremental sync checks heads");
  assert.equal(scans.length + walks.length, 0, "unchanged heads and covered history do nothing");
  assert.equal(sdb.state.reads, 0, "and transfer no snapshot");
  assert.equal((await lib.ownershipRevisions(sdb, [1]))[0].calculatedAt, "2020-01-01T00:00:00Z");
  revision = "b".repeat(40);
  await lib.runSync({ ...syncOptions, repoIds: [1] });
  assert.equal(scans.at(-1).previousRef, saved.cacheRef, "a changed head continues from the native cache");
  assert.equal(walks.at(-1).checkpointRef?.startsWith("ck-"), true, "and history extends its visible generation");
  assert.equal(walks.at(-1).generation, 1);
  const beforeFull = (await lib.historyGenState(sdb, 1)).visibleGeneration;
  scans = []; walks = [];
  await lib.runSync({ ...syncOptions, repoIds: [1], mode: "full" });
  assert.equal(scans[0].previousRef, null);
  assert.equal(walks[0].generation, beforeFull + 1, "full re-sync builds a new generation");
  pass("sync: concurrent preparation, native cache refs, resume, unchanged heads, incremental extension, full rebuild");

  resetOnce = true;
  revision = "c".repeat(40);
  walks = [];
  await lib.runSync({ ...syncOptions, repoIds: [1] });
  assert.equal(walks.length, 2, "a rewritten branch restarts once in a new generation");
  assert.equal(walks[1].checkpointRef, null);
  assert.ok(walks[1].generation > walks[0].generation);
  localStorage.setItem("github-monitor.ownership.engine", "replay");
  finalLines = 99;
  revision = "d".repeat(40);
  walks = [];
  const mismatch = await lib.runSync({ ...syncOptions, repoIds: [1] });
  assert.deepEqual(walks.map((w) => w.engine), ["replay", "blame"], "a replayed history that fails verification is rebuilt with blame");
  assert.equal(mismatch.errors.length, 1, "and a blame mismatch is an error");
  assert.equal((await lib.ownershipRevisions(sdb, [1]))[0].history.kind, "generation", "the previous verified history stays visible");
  finalLines = 3;
  walks = [];
  await lib.runSync({ ...syncOptions, repoIds: [1] });
  assert.deepEqual(walks.map((w) => w.engine), ["blame"], "that repository keeps using blame");
  localStorage.setItem("github-monitor.ownership.engine", "blame");
  walks = [];
  revision = "9".repeat(40);
  await lib.runSync({ ...syncOptions, repoIds: [2] });
  assert.deepEqual(walks.map((w) => w.engine), ["blame"], "choosing blame in Settings is honoured");
  localStorage.removeItem("github-monitor.ownership.engine");
  pass("sync: reset on rewrite, verification against the HEAD scan, replay falls back to blame");

  const legacyJson = JSON.stringify({ version: 2, files: {}, coauthors: {}, report: report(revision) });
  sdb.sqlite.prepare("UPDATE line_ownership SET snapshot = ?, report = NULL, metadata = NULL, cache_ref = NULL WHERE repo_id = 2").run(legacyJson);
  scans = [];
  await lib.runSync({ ...syncOptions, repoIds: [2] });
  assert.equal(scans[0].previousJson, legacyJson, "a legacy snapshot converts once, even with an unchanged head");
  assert.equal((await lib.ownershipCheckpoint(sdb, 2)).legacyJson, null);
  const beforeFailure = await lib.ownershipCheckpoint(sdb, 1);
  globalThis.__invoke = async () => { throw new Error("Git fetch failed"); };
  const failed = await lib.runSync({ ...syncOptions, repoIds: [1] });
  assert.equal(failed.errors[0].endpoint, "line_ownership");
  assert.deepEqual(await lib.ownershipCheckpoint(sdb, 1), beforeFailure);
  assert.equal((await lib.ownershipRevisions(sdb, [1]))[0].status, "error");
  setScanner(scanner);
  const controller = new AbortController();
  let cancelled = false;
  revision = "e".repeat(40);
  globalThis.__invoke = ((inner) => async (command, args) => {
    if (command === "cancel_line_ownership") { cancelled = true; return; }
    if (command === "sync_line_ownership") { controller.abort(); return scanner(command, args); }
    return inner(command, args);
  })(globalThis.__invoke);
  const stopped = await lib.runSync({ ...syncOptions, repoIds: [1], signal: controller.signal });
  assert.equal(stopped.cancelled, true);
  assert.equal(cancelled, true);
  assert.deepEqual(await lib.ownershipCheckpoint(sdb, 1), beforeFailure, "cancellation does not advance the checkpoint");
  setScanner(scanner);
  sdb.state.failOn = /INSERT INTO line_ownership \(/;
  revision = "f".repeat(40);
  const writeFailed = await lib.runSync({ ...syncOptions, repoIds: [1] });
  sdb.state.failOn = null;
  assert.equal(writeFailed.errors.length, 1);
  assert.deepEqual(await lib.ownershipCheckpoint(sdb, 1), beforeFailure, "a failed write keeps the old report and cache together");
  const meta = await lib.ownershipMetadata(sdb, 1);
  assert.equal(await lib.touchOwnershipSnapshot(sdb, 1, meta), true);
  assert.equal(await lib.touchOwnershipSnapshot(sdb, 1, meta.replace('"version":2', '"version":999')), false);
  await lib.clearAnalytics(sdb);
  assert.equal(await lib.ownershipCheckpoint(sdb, 1), null);
  assert.equal((await lib.ownershipRevisions(sdb, [1]))[0].history.kind, "none", "analytics reset clears history");
  pass("legacy snapshot conversion, failed fetch/write retention, cancellation and analytics reset");

  assert.equal(lib.verifyHistoryFinal({ totalLines: 3, groups: [[[["Alice", "alice@x"], ["Alice", "alice@x"]], 3]] }, report("x")), null, "duplicate co-author entries compare as one person");
  assert.match(lib.verifyHistoryFinal({ totalLines: 3, groups: [[[["Bob", "bob@x"]], 3]] }, report("x")), /does not match/);
  pass("history verification compares raw attribution with the HEAD scan");
} finally {
  for (const sqlite of sqlites) try { sqlite.close(); } catch { /* already closed */ }
  rmSync(work, { recursive: true, force: true });
}
