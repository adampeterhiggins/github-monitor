import type { FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  importOpenVsxThemeExtension,
  searchOpenVsxThemes,
  type OpenVsxThemeExtension,
  type OpenVsxThemeSort,
} from "../lib/theme/openVsx";
import {
  getStoredCustomThemeCollection,
  replaceCustomThemeCollection,
  type ThemeDefinition,
} from "../lib/theme/palette";
import { Button, Spinner } from "./ui";

const DOWNLOAD_FORMAT = new Intl.NumberFormat("en-GB", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const SUGGESTED_SEARCHES = ["Dracula", "Catppuccin", "Nord", "Tokyo Night"];
const SORT_OPTIONS: ReadonlyArray<{ value: OpenVsxThemeSort; label: string }> = [
  { value: "downloadCount", label: "Most downloaded" },
  { value: "rating", label: "Best rated" },
  { value: "timestamp", label: "Newest" },
  { value: "relevance", label: "Most relevant" },
];

function ThemeExtensionIcon({ extension }: { extension: OpenVsxThemeExtension }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-wash text-[11px] font-medium text-ink-muted">
      {extension.iconUrl && !failed ? (
        <img
          alt=""
          className="size-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={extension.iconUrl}
          onError={() => setFailed(true)}
        />
      ) : (
        "Aa"
      )}
    </div>
  );
}

export function ThemeSearchSection({
  open,
  onInstalled,
}: {
  open: boolean;
  onInstalled: (themes: ReadonlyArray<ThemeDefinition>, context: { updated: boolean }) => void;
}) {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<OpenVsxThemeSort>("downloadCount");
  const [results, setResults] = useState<ReadonlyArray<OpenVsxThemeExtension> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<OpenVsxThemeExtension | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    if (open) {
      setQuery("");
      setSortBy("downloadCount");
      setResults(null);
      setError(null);
      setIsSearching(false);
      setInstallingId(null);
      setPendingUpdate(null);
    }
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [open]);

  const runSearch = useCallback(
    async (searchText: string, nextSort = sortBy) => {
      const trimmed = searchText.trim();
      if (!trimmed) return;
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setQuery(trimmed);
      setIsSearching(true);
      setError(null);
      setResults(null);
      try {
        const nextResults = await searchOpenVsxThemes(trimmed, {
          signal: controller.signal,
          sortBy: nextSort,
        });
        if (!controller.signal.aborted) setResults(nextResults);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Open VSX search failed.");
        }
      }
      if (requestRef.current === controller) {
        requestRef.current = null;
        setIsSearching(false);
      }
    },
    [sortBy],
  );

  const handleInstall = useCallback(
    async (extension: OpenVsxThemeExtension, allowUpdate: boolean) => {
      setError(null);
      let installedCollection: ReadonlyArray<ThemeDefinition>;
      try {
        installedCollection = getStoredCustomThemeCollection(extension.collectionId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Installed themes could not be read.");
        return;
      }
      const updated = installedCollection.length > 0;
      if (updated && !allowUpdate) {
        setPendingUpdate(extension);
        return;
      }

      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setInstallingId(extension.id);
      try {
        const themes = await importOpenVsxThemeExtension(extension, controller.signal);
        if (!controller.signal.aborted) {
          const imported = replaceCustomThemeCollection(extension.collectionId, themes, {
            expectedCollection: installedCollection,
          });
          onInstalled(imported, { updated });
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "That theme could not be added.");
        }
      }
      if (requestRef.current === controller) {
        requestRef.current = null;
        setInstallingId(null);
      }
    },
    [onInstalled],
  );

  return (
    <section className="space-y-3" aria-labelledby="theme-search-heading">
      <div>
        <h3 className="text-[13px] font-medium text-ink" id="theme-search-heading">
          Search VS Code themes
        </h3>
        <p className="mt-0.5 text-[12px] text-ink-secondary">
          Licensed community themes from Open VSX, converted the same way as a file import.
        </p>
      </div>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void runSearch(query);
        }}
      >
        <input
          aria-label="Search themes"
          className="h-8 min-w-40 flex-1 rounded-md border border-hairline-strong bg-surface px-2.5 text-[12px] text-ink focus:outline-2 focus:outline-offset-0 focus:outline-accent"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search Open VSX"
          value={query}
        />
        <select
          aria-label="Sort themes"
          className="h-8 rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-ink"
          onChange={(event) => {
            const nextSort = event.currentTarget.value as OpenVsxThemeSort;
            setSortBy(nextSort);
            if ((results !== null || isSearching) && query.trim()) {
              void runSearch(query, nextSort);
            }
          }}
          value={sortBy}
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Button size="md" type="submit" disabled={isSearching || !query.trim()}>
          {isSearching ? <Spinner /> : null}
          Search
        </Button>
      </form>

      <div className="flex flex-wrap gap-1.5">
        {SUGGESTED_SEARCHES.map((suggestion) => (
          <Button
            key={suggestion}
            variant="ghost"
            onClick={() => void runSearch(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </div>

      {error ? <p className="text-[12px] text-critical">{error}</p> : null}

      {pendingUpdate ? (
        <div className="rounded-md border border-hairline bg-wash p-3">
          <p className="text-[13px] font-medium text-ink">Already installed</p>
          <p className="mt-1 text-[12px] text-ink-secondary">
            {pendingUpdate.name} is already in your library. Update it, or keep the current copy.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => {
                const extension = pendingUpdate;
                setPendingUpdate(null);
                void handleInstall(extension, true);
              }}
            >
              Update
            </Button>
            <Button variant="ghost" onClick={() => setPendingUpdate(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {results ? (
        results.length === 0 ? (
          <p className="text-[12px] text-ink-secondary">No licensed theme extensions matched.</p>
        ) : (
          <ul className="divide-y divide-hairline rounded-md border border-hairline">
            {results.map((extension) => {
              const installing = installingId === extension.id;
              return (
                <li key={extension.id} className="flex items-center gap-3 px-3 py-2.5">
                  <ThemeExtensionIcon extension={extension} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">{extension.name}</div>
                    <div className="truncate text-[11px] text-ink-muted">
                      {extension.publisher}
                      {extension.downloadCount > 0
                        ? ` · ${DOWNLOAD_FORMAT.format(extension.downloadCount)} installs`
                        : ""}
                      {` · ${extension.license}`}
                    </div>
                  </div>
                  <Button
                    disabled={installingId !== null}
                    onClick={() => void handleInstall(extension, false)}
                  >
                    {installing ? <Spinner /> : null}
                    {installing ? "Adding…" : "Add"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </section>
  );
}
