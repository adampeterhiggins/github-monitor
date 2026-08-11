/**
 * Positional parameter builder.
 *
 * Queries here compose optional filters (repository ids, contributor logins), so
 * hand-numbering `$1`, `$2`, … breaks as soon as a clause becomes conditional.
 * This hands out placeholders in order and collects the values alongside, so
 * values are always bound rather than interpolated.
 */
export class Params {
  readonly values: unknown[] = [];

  /** Bind one value, returning its placeholder. */
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  /**
   * Bind a list as an `IN (…)` group. An empty list yields `(NULL)`, which matches
   * nothing — the correct reading of "no repositories selected".
   */
  in(list: readonly unknown[]): string {
    if (list.length === 0) return "(NULL)";
    return `(${list.map((v) => this.add(v)).join(", ")})`;
  }

  /**
   * An optional case-insensitive login filter.
   *
   * `null` or an empty list means "every contributor" and produces no clause at
   * all, so the unfiltered query plan is unchanged. GitHub treats logins
   * case-insensitively while the cache stores whatever casing the API returned,
   * hence LOWER() on both sides.
   */
  loginFilter(column: string, logins: readonly string[] | null | undefined): string {
    if (!logins || logins.length === 0) return "";
    const placeholders = logins.map((l) => `LOWER(${this.add(l)})`).join(", ");
    return ` AND LOWER(${column}) IN (${placeholders})`;
  }
}
