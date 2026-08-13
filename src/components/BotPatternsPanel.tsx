import { useMemo, useState } from "react";
import { useApp } from "../lib/state/app";
import { useScope, useScopedQuery } from "../lib/hooks";
import { listContributors } from "../lib/db/queries";
import { BUILT_IN_BOT_PATTERNS, isBot, matchesPattern } from "../lib/bots";
import { Button, Card, CardHeader, full } from "./ui";

/**
 * Which logins count as bots.
 *
 * The built-in list is shown rather than described, because the only way to trust
 * "deselect bots" is to see what it thinks a bot is. Added patterns are matched
 * against the contributors already in the cache as you type them, so a pattern that
 * would sweep up a colleague says so before it is saved rather than after.
 */
export function BotPatternsPanel() {
  const scope = useScope();
  const patterns = useApp((s) => s.botPatterns);
  const setBotPatterns = useApp((s) => s.setBotPatterns);
  const [draft, setDraft] = useState("");

  const contributors = useScopedQuery(
    "contributor-list-bots",
    scope,
    (db) => listContributors(db, scope.repoIds),
    { staleTime: 5 * 60_000 },
  );

  const logins = useMemo(
    () => (contributors.data ?? []).map((c) => c.login),
    [contributors.data],
  );

  /** What the draft would newly match — the check worth doing before saving. */
  const draftMatches = useMemo(() => {
    const trimmed = draft.trim();
    if (!trimmed) return [];
    return logins.filter(
      (l) => matchesPattern(l, trimmed) && !isBot(l, patterns),
    );
  }, [draft, logins, patterns]);

  const detected = useMemo(() => logins.filter((l) => isBot(l, patterns)), [logins, patterns]);

  const add = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setBotPatterns([...patterns, trimmed]);
    setDraft("");
  };

  return (
    <Card>
      <CardHeader
        title="Bots and agents"
        subtitle="Which logins the contributor filter can deselect in one go"
      />

      <div className="flex flex-col gap-3">
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            Your patterns
          </p>
          {patterns.length === 0 ? (
            <p className="text-[12px] text-ink-secondary">
              None yet. AI coding agents are worth adding here — they commit under
              whatever identity was configured, and every one of their names is also a
              real person's username, so none of them are detected automatically.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {patterns.map((p) => (
                <span
                  key={p}
                  className="inline-flex items-center gap-1.5 rounded-md border border-hairline-strong bg-surface px-2 py-0.5 text-[12px] text-ink"
                >
                  <code>{p}</code>
                  <button
                    type="button"
                    aria-label={`Remove ${p}`}
                    title={`Remove ${p}`}
                    onClick={() => setBotPatterns(patterns.filter((x) => x !== p))}
                    className="text-ink-muted hover:text-ink"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            placeholder="A login, or a pattern like agent-*"
            className="h-8 min-w-[220px] flex-1 rounded-md border border-hairline-strong bg-surface px-2.5 text-[12px] text-ink placeholder:text-ink-muted focus:outline-2 focus:outline-offset-0 focus:outline-accent"
          />
          <Button size="md" onClick={add} disabled={draft.trim().length === 0}>
            Add
          </Button>
        </div>

        {draft.trim() ? (
          <p className="text-[11px] text-ink-secondary">
            {draftMatches.length === 0 ? (
              <>Matches nobody currently in the cache.</>
            ) : (
              <>
                Would newly match{" "}
                <strong className="text-ink">{draftMatches.slice(0, 8).join(", ")}</strong>
                {draftMatches.length > 8 ? ` and ${full(draftMatches.length - 8)} more` : ""}.
              </>
            )}
          </p>
        ) : null}

        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            Detected now
          </p>
          <p className="text-[12px] text-ink-secondary">
            {detected.length === 0
              ? "No cached contributor matches, built-ins included."
              : detected.join(", ")}
          </p>
        </div>

        <details className="text-[12px] text-ink-secondary">
          <summary className="cursor-pointer text-ink">
            Built-in patterns ({full(BUILT_IN_BOT_PATTERNS.length)})
          </summary>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {BUILT_IN_BOT_PATTERNS.map((p) => (
              <code
                key={p}
                className="rounded border border-hairline px-1.5 py-0.5 text-[11px] text-ink-secondary"
              >
                {p}
              </code>
            ))}
          </div>
          <p className="mt-2 leading-relaxed">
            Matching is case-insensitive and <code>*</code> stands for any run of
            characters. GitHub gives contributor statistics as a login and nothing
            else — no account type — so this is a guess made from names, which is why
            it deselects rather than hides, and why nothing here is applied without
            you asking for it.
          </p>
        </details>
      </div>
    </Card>
  );
}
