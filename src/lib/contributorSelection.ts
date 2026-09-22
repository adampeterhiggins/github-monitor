// Empty means "all contributors" throughout the app. This impossible Git login
// represents an explicit empty selection, e.g. after deselecting a bots-only list.
export const NO_CONTRIBUTORS = "\u0000";

export interface SelectableContributor {
  login: string;
  aliases?: string[];
}

export function contributorKeys(contributor: SelectableContributor): string[] {
  return [contributor.login, ...(contributor.aliases ?? [])].map((value) => value.toLowerCase());
}

export function deselectContributors(
  selected: readonly string[],
  all: readonly SelectableContributor[],
  removed: readonly SelectableContributor[],
): string[] {
  const drop = new Set(removed.flatMap(contributorKeys));
  const base = selected.length === 0 ? all.map((c) => c.login) : selected;
  const remaining = base.filter((login) => !drop.has(login.toLowerCase()));
  return remaining.length ? remaining : [NO_CONTRIBUTORS];
}
