/**
 * Filter taxonomy: FINN's filter codes, fetched live and cached.
 *
 * Every filter value on FINN Jobb is an opaque code (`occupation=1.23.2047`,
 * `industry=8`, `extent=3947`). Rather than hard-coding those — they change
 * when FINN reorganises its taxonomy, as the 2024 county reform did — we read
 * them from the `filters` array that every search response carries, and resolve
 * user-supplied names against it.
 *
 * The taxonomy is fetched once per process from an unfiltered search (an
 * unfiltered request is the only one that returns the *complete* tree; once a
 * location is selected, for example, FINN narrows the location filter to the
 * selected branch).
 */

import { search, type FilterGroup, type FilterItem } from "./finn.js";

/** Filter parameter names accepted by the search endpoint. */
export const FILTER_NAMES = [
  "published",
  "location",
  "occupation",
  "industry",
  "education",
  "work_experience",
  "extent",
  "job_duration",
  "job_sector",
  "working_language",
  "home_office",
  "manager_role",
  "applicationdeadline",
] as const;

export type FilterName = (typeof FILTER_NAMES)[number];

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

const TAXONOMY_TTL_MS = 60 * 60 * 1000; // 1 hour

let cache: { at: number; groups: Map<string, FilterGroup> } | null = null;
let inFlight: Promise<Map<string, FilterGroup>> | null = null;

async function loadTaxonomy(): Promise<Map<string, FilterGroup>> {
  const res = await search(new URLSearchParams({ rows: "1" }));
  const groups = new Map<string, FilterGroup>();
  for (const group of res.filters ?? []) {
    if (group?.name) groups.set(group.name, group);
  }
  cache = { at: Date.now(), groups };
  return groups;
}

export async function getTaxonomy(): Promise<Map<string, FilterGroup>> {
  if (cache && Date.now() - cache.at < TAXONOMY_TTL_MS) return cache.groups;
  if (!inFlight) {
    inFlight = loadTaxonomy().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

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

export async function optionsFor(name: FilterName): Promise<ResolvedOption[]> {
  const groups = await getTaxonomy();
  return flatten(groups.get(name));
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
    readonly filter: FilterName,
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

/**
 * Resolve one user-supplied value for a filter into its FINN code.
 *
 * Accepts, in order of preference: a raw code, an exact display name, a
 * case/accent-insensitive match, a unique prefix match, and finally a unique
 * substring match. Ambiguous matches are broken by ad count so that "Oslo"
 * resolves to the municipality rather than a namesake district, and matches
 * closer to the root of a tree win over deeper ones.
 */
export async function resolveOption(
  filter: FilterName,
  input: string,
): Promise<ResolvedOption> {
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

export async function resolveAll(
  filter: FilterName,
  inputs: string[] | undefined,
): Promise<ResolvedOption[]> {
  if (!inputs?.length) return [];
  return Promise.all(inputs.map((i) => resolveOption(filter, i)));
}

/**
 * Aliases that let callers use plain English for the small closed-vocabulary
 * filters. Each alias maps to the Norwegian display name FINN uses, which is
 * then resolved to a code through the live taxonomy — so the codes themselves
 * are still never hard-coded.
 */
export const ALIASES: Record<string, Record<string, string>> = {
  extent: {
    full_time: "Heltid",
    part_time: "Deltid",
  },
  home_office: {
    hybrid: "Delvis hjemmekontor",
    remote: "Kun hjemmekontor",
    onsite: "På kontoret",
  },
  job_sector: {
    private: "Privat",
    public: "Offentlig",
    organisation: "Organisasjoner",
    cooperative: "Samvirke",
    franchise: "Franchise/Selvstendig næringsdrivende",
  },
  job_duration: {
    permanent: "Fast",
    temporary: "Vikariat",
    engagement: "Engasjement",
    project: "Prosjekt",
    staffing_agency: "Bemanningsbyrå",
    apprentice: "Lærling",
    self_employed: "Selvstendig næringsdrivende",
    seasonal: "Sommer/Sesong",
    trainee: "Trainee",
  },
  work_experience: {
    none: "Ingen erfaring",
    junior: "Junior",
    experienced: "Erfaren",
    manager: "Leder",
  },
  working_language: {
    norwegian: "Norsk",
    english: "Engelsk",
  },
  manager_role: {
    director: "Direktør",
    manager: "Leder",
    team_lead: "Fagleder",
  },
};

/** Apply the alias table before resolving, so both spellings work. */
export async function resolveWithAliases(
  filter: FilterName,
  input: string,
): Promise<ResolvedOption> {
  const alias = ALIASES[filter]?.[input.trim().toLowerCase().replace(/[\s-]+/g, "_")];
  return resolveOption(filter, alias ?? input);
}

/** Decode a code back to its display name, for rendering search results. */
export async function labelFor(
  filter: FilterName,
  value: string,
): Promise<string> {
  const options = await optionsFor(filter);
  return options.find((o) => o.value === String(value))?.name ?? value;
}
