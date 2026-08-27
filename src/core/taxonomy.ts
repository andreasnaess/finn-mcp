/**
 * Filter taxonomy: FINN's filter codes, fetched live and cached.
 *
 * Every filter value on FINN is an opaque code (`occupation=1.23.2047`,
 * `industry=8`, `extent=3947`). Rather than hard-coding those — they change
 * when FINN reorganises its taxonomy, as the 2024 county reform did — we read
 * them from the `filters` array that every search response carries, and resolve
 * user-supplied names against it.
 *
 * The engine is vertical-agnostic: `createTaxonomy` binds it to one vertical's
 * endpoint and alias table, and each vertical gets its own cache. Filter names
 * are the type parameter `F`, so a vertical keeps full type-safety over its own
 * filter list (see `FilterName` in `jobs/config.ts`).
 *
 * The taxonomy is fetched once per process from an unfiltered search (an
 * unfiltered request is the only one that returns the *complete* tree; once a
 * location is selected, for example, FINN narrows the location filter to the
 * selected branch).
 */

import { search, type FilterGroup, type FilterItem, type Vertical } from "./http.js";

export interface ResolvedOption {
  /** Display name exactly as FINN spells it. */
  name: string;
  /** The code to send as the query-parameter value. */
  value: string;
  /** Ancestors, outermost first, e.g. ["Norge", "Vestland"] for Bergen. */
  path: string[];
  /** Number of ads under this option in the unfiltered index. */
  hits?: number;
}

/**
 * Aliases that let callers use plain English for the small closed-vocabulary
 * filters. Each alias maps to the Norwegian display name FINN uses, which is
 * then resolved to a code through the live taxonomy — so the codes themselves
 * are still never hard-coded.
 */
export type Aliases = Record<string, Record<string, string>>;

const TAXONOMY_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Flatten a filter group into a list of options, keeping ancestry. */
export function flatten(group: FilterGroup | undefined): ResolvedOption[] {
  const out: ResolvedOption[] = [];
  const walk = (items: FilterItem[] | undefined, path: string[]): void => {
    for (const item of items ?? []) {
      out.push({
        name: item.display_name,
        value: String(item.value),
        path,
        hits: item.hits,
      });
      walk(item.filter_items, [...path, item.display_name]);
    }
  };
  walk(group?.filter_items, []);
  return out;
}

const normalise = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Does `input` look like a raw FINN code rather than a display name? */
function looksLikeCode(input: string): boolean {
  return /^\d+(\.\d+)*$/.test(input.trim());
}

/** Levenshtein distance, capped — used only to suggest alternatives. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev.splice(0, prev.length, ...row);
  }
  return prev[b.length]!;
}

export class UnknownOptionError extends Error {
  constructor(
    readonly filter: string,
    readonly input: string,
    readonly suggestions: ResolvedOption[],
  ) {
    const hint = suggestions.length
      ? ` Did you mean: ${suggestions.map((s) => s.name).join(", ")}?`
      : "";
    super(
      `No ${filter} option on finn.no matches "${input}".${hint}` +
        ` Use the list_filter_options tool to see what is available.`,
    );
    this.name = "UnknownOptionError";
  }
}

/** One vertical's bound taxonomy. */
export interface Taxonomy<F extends string> {
  /** The alias table this taxonomy was built with, for tool descriptions. */
  aliases: Aliases;
  optionsFor(filter: F): Promise<ResolvedOption[]>;
  resolveOption(filter: F, input: string): Promise<ResolvedOption>;
  resolveWithAliases(filter: F, input: string): Promise<ResolvedOption>;
  resolveAll(filter: F, inputs: string[] | undefined): Promise<ResolvedOption[]>;
  labelFor(filter: F, value: string): Promise<string>;
}

/** Bind the taxonomy engine to one vertical. Each call gets its own cache. */
export function createTaxonomy<F extends string>(
  vertical: Vertical,
  aliases: Aliases,
): Taxonomy<F> {
  let cache: { at: number; groups: Map<string, FilterGroup> } | null = null;
  let inFlight: Promise<Map<string, FilterGroup>> | null = null;

  async function load(): Promise<Map<string, FilterGroup>> {
    const res = await search<unknown>(vertical, new URLSearchParams({ rows: "1" }));
    const groups = new Map<string, FilterGroup>();
    for (const group of res.filters ?? []) {
      if (group?.name) groups.set(group.name, group);
    }
    cache = { at: Date.now(), groups };
    return groups;
  }

  async function getTaxonomy(): Promise<Map<string, FilterGroup>> {
    if (cache && Date.now() - cache.at < TAXONOMY_TTL_MS) return cache.groups;
    if (!inFlight) {
      inFlight = load().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  async function optionsFor(filter: F): Promise<ResolvedOption[]> {
    const groups = await getTaxonomy();
    return flatten(groups.get(filter));
  }

  /**
   * Resolve one user-supplied value for a filter into its FINN code.
   *
   * Accepts, in order of preference: a raw code, an exact display name, a
   * case/accent-insensitive match, a unique prefix match, and finally a unique
   * substring match. Ambiguous matches are broken by ad count so that "Oslo"
   * resolves to the municipality rather than a namesake district, and matches
   * closer to the root of a tree win over deeper ones.
   */
  async function resolveOption(filter: F, input: string): Promise<ResolvedOption> {
    const options = await optionsFor(filter);
    const raw = input.trim();

    if (looksLikeCode(raw)) {
      const byCode = options.find((o) => o.value === raw);
      // Unknown-but-well-formed codes are passed through: FINN's taxonomy is
      // larger than any one response, and a wrong code simply returns 0 hits.
      return byCode ?? { name: raw, value: raw, path: [] };
    }

    const target = normalise(raw);
    const rank = (o: ResolvedOption): number => o.path.length * 1e9 - (o.hits ?? 0);
    const best = (candidates: ResolvedOption[]): ResolvedOption | undefined =>
      candidates.length ? candidates.slice().sort((a, b) => rank(a) - rank(b))[0] : undefined;

    const exact = best(options.filter((o) => normalise(o.name) === target));
    if (exact) return exact;

    const prefix = best(options.filter((o) => normalise(o.name).startsWith(target)));
    if (prefix) return prefix;

    const substring = best(options.filter((o) => normalise(o.name).includes(target)));
    if (substring) return substring;

    // Nothing matched. Offer the nearest names so a typo is easy to correct:
    // first anything sharing a word, then the closest spellings.
    const byWord = options.filter((o) => {
      const n = normalise(o.name);
      return target.split(" ").some((word) => word.length > 2 && n.includes(word));
    });
    const byDistance = options
      .map((o) => ({ o, d: editDistance(target, normalise(o.name)) }))
      .filter(({ d }) => d <= Math.max(2, Math.floor(target.length / 3)))
      .sort((a, b) => a.d - b.d || (b.o.hits ?? 0) - (a.o.hits ?? 0))
      .map(({ o }) => o);

    const seen = new Set<string>();
    const suggestions = [...byWord.sort((a, b) => (b.hits ?? 0) - (a.hits ?? 0)), ...byDistance]
      .filter((o) => !seen.has(o.value) && seen.add(o.value))
      .slice(0, 8);

    throw new UnknownOptionError(filter, raw, suggestions);
  }

  /** Apply the alias table before resolving, so both spellings work. */
  async function resolveWithAliases(filter: F, input: string): Promise<ResolvedOption> {
    const alias = aliases[filter]?.[input.trim().toLowerCase().replace(/[\s-]+/g, "_")];
    return resolveOption(filter, alias ?? input);
  }

  async function resolveAll(
    filter: F,
    inputs: string[] | undefined,
  ): Promise<ResolvedOption[]> {
    if (!inputs?.length) return [];
    return Promise.all(inputs.map((i) => resolveOption(filter, i)));
  }

  /** Decode a code back to its display name, for rendering search results. */
  async function labelFor(filter: F, value: string): Promise<string> {
    const options = await optionsFor(filter);
    return options.find((o) => o.value === String(value))?.name ?? value;
  }

  return {
    aliases,
    optionsFor,
    resolveOption,
    resolveWithAliases,
    resolveAll,
    labelFor,
  };
}
