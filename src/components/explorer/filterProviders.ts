import type { DatabaseProvider } from "../../config/providers";

export interface FilterProvidersOptions {
  /** When false, providers with `comingSoon: true` are hidden. */
  showAll: boolean;
  /** Optional case-insensitive substring match against the provider name. */
  search?: string;
  /** Optional category filter; "All" / "Popular" are treated as no-op. */
  category?: string;
}

/**
 * Pure filter for the connection dialog driver picker.
 *
 * Order of operations matters: the `showAll` tier filter runs FIRST so that
 * search results stay within the active tier (default = supported only).
 */
export function filterProviders(
  providers: ReadonlyArray<DatabaseProvider>,
  opts: FilterProvidersOptions
): DatabaseProvider[] {
  const { showAll, search, category } = opts;
  const needle = search?.trim().toLowerCase() ?? "";

  return providers.filter(p => {
    // Tier filter first — coming-soon tiles only appear when showAll is on.
    if (!showAll && p.comingSoon) return false;

    // Category filter ("All" / "Popular" are no-ops, mirroring existing UI).
    if (category && category !== "All" && category !== "Popular" && p.type !== category) {
      return false;
    }

    // Search runs last so it works in both tiers.
    if (needle && !p.name.toLowerCase().includes(needle)) return false;

    return true;
  });
}

/** Count of providers in the coming-soon tier (used for the toggle label). */
export function getComingSoonCount(providers: ReadonlyArray<DatabaseProvider>): number {
  return providers.reduce((n, p) => n + (p.comingSoon ? 1 : 0), 0);
}
