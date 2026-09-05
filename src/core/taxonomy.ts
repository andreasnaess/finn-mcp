/**
 * Filter taxonomy: FINN's filter codes, fetched live and cached.
 *
 * Every filter value on FINN is an opaque code (`occupation=1.23.2047`,
 * `industry=8`, `extent=3947`). Rather than hard-coding those — they change
 * when FINN reorganises its taxonomy, as the 2024 county reform did — we read
 * them from the `filters` array that every search response carries, and resolve
 * user-supplied names against it.
 *
 * The engine is marketplace-agnostic: `createTaxonomy` binds it to one
 * marketplace's endpoint and alias table, and each marketplace gets its own
 * cache. Filter names are the type parameter `F`, so a marketplace keeps full
 * type-safety over its own filter list (see `FilterName` in `jobs/config.ts`).
 *
 * The taxonomy is fetched once per process (per Worker isolate, when served
 * over HTTP) from an unfiltered search (an
 * unfiltered request is the only one that returns the *complete* tree; once a
 * location is selected, for example, FINN narrows the location filter to the
 * selected branch).
 */

import { search, type FilterGroup, type FilterItem, type Marketplace } from "./http.js";

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

/**
 * How long Cloudflare's cache keeps the filter tree, as opposed to how long an
 * isolate trusts its own copy (`TAXONOMY_TTL_MS`, above).
 *
 * These answer different questions and should not share a number. The memory
 * TTL is about freshness: an hour is comfortably shorter than the roughly
 * yearly pace at which FINN renumbers anything. The edge TTL is about
 * availability: it decides how often a cold isolate has to ask finn.no at all,
 * and finn.no serves Cloudflare's egress a sporadic 403 (see `RETRY_STATUSES`
 * in http.ts). Matching them meant 24 chances a day to catch a refusal with an
 * empty memory cache and nothing to fall back to — which is a failed tool call.
 *
 * A day of edge cache costs nothing real, because a filter tree that is hours
 * old is indistinguishable from a fresh one, and it turns those 24 exposures
 * into one.
 */
const TAXONOMY_EDGE_TTL_S = 24 * 60 * 60; // 1 day

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

/** One marketplace's bound taxonomy. */
export interface Taxonomy<F extends string> {
  /** The alias table this taxonomy was built with, for tool descriptions. */
  aliases: Aliases;
  optionsFor(filter: F): Promise<ResolvedOption[]>;
  /** Options already in memory, or `[]`. Never fetches. See `cachedOptionsFor`. */
  cachedOptionsFor(filter: F): ResolvedOption[];
  resolveOption(filter: F, input: string): Promise<ResolvedOption>;
  resolveWithAliases(filter: F, input: string): Promise<ResolvedOption>;
  resolveAll(filter: F, inputs: string[] | undefined): Promise<ResolvedOption[]>;
  labelFor(filter: F, value: string): Promise<string>;
}

/** Bind the taxonomy engine to a marketplace. Each call gets its own cache. */
export function createTaxonomy<F extends string>(
  marketplace: Marketplace,
  aliases: Aliases,
): Taxonomy<F> {
  let cache: { at: number; groups: Map<string, FilterGroup> } | null = null;

  async function load(): Promise<Map<string, FilterGroup>> {
    const res = await search<unknown>(
      marketplace,
      // rows=0, not rows=1: the filter tree is byte-identical either way, and
      // `rows=1` is a URL a bare search_jobs({ limit: 1 }) also produces. That
      // would share this request's cache entry, and be served a day-old result
      // — this entry is cached far longer than a search should be. `limit` has
      // a minimum of 1, so rows=0 is ours alone.
      new URLSearchParams({ rows: "0" }),
      TAXONOMY_EDGE_TTL_S,
    );
    const groups = new Map<string, FilterGroup>();
    for (const group of res.filters ?? []) {
      if (group?.name) groups.set(group.name, group);
    }
    cache = { at: Date.now(), groups };
    return groups;
  }

  /**
   * Concurrent callers that both miss the cache each do their own fetch, and
   * the last to finish wins. Sharing one in-flight promise would be the
   * obvious dedupe, but a promise cannot be awaited across two Cloudflare
   * Worker requests ("Cannot perform I/O on behalf of a different request"),
   * and the duplicate fetch it saves only ever happens on a cold cache.
   */
  async function getTaxonomy(): Promise<Map<string, FilterGroup>> {
    if (cache && Date.now() - cache.at < TAXONOMY_TTL_MS) return cache.groups;
    try {
      return await load();
    } catch (err) {
      // Filter codes change about once a year, so a stale tree beats failing
      // the tool call outright when finn.no is refusing us this minute.
      if (cache) return cache.groups;
      throw err;
    }
  }

  async function optionsFor(filter: F): Promise<ResolvedOption[]> {
    const groups = await getTaxonomy();
    return flatten(groups.get(filter));
  }

  /**
   * What this isolate already knows, without asking finn.no.
   *
   * For callers that would like the taxonomy but must not pay a request for
   * it. On Cloudflare that is the difference between a working connector and a
   * broken one: workers.dev has no edge cache, so "fetch if missing" means one
   * request to finn.no per cold isolate, and finn.no answers that volume from
   * Cloudflare's range with a 403.
   */
  function cachedOptionsFor(filter: F): ResolvedOption[] {
    if (!cache || Date.now() - cache.at >= TAXONOMY_TTL_MS) return [];
    return flatten(cache.groups.get(filter));
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
    cachedOptionsFor,
    resolveOption,
    resolveWithAliases,
    resolveAll,
    labelFor,
  };
}
