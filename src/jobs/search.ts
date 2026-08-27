/** Search parameter assembly and result rendering for FINN Jobb. */

import { search, webSearchUrl, type SearchResponse } from "../core/http.js";
import { type ResolvedOption } from "../core/taxonomy.js";
import { JOBS, taxonomy, type FilterName } from "./config.js";

/** A single result row from the jobs search API. */
export interface JobDoc {
  id: string;
  ad_id: number;
  heading: string;
  job_title?: string;
  company_name?: string;
  location?: string;
  locations?: string[];
  work_locations?: string[][];
  canonical_url: string;
  published?: number;
  deadline?: number;
  timestamp?: number;
  no_of_positions?: number;
  coordinates?: { lat: number; lon: number };
  flags?: string[];
  labels?: { id: string; text: string; type?: string }[];
  extras?: { id: string; label: string; values: string[] }[];
  logo?: { url?: string };
}

export type JobSearchResponse = SearchResponse<JobDoc>;

export const SORTS = {
  relevance: "RELEVANCE",
  published: "PUBLISHED_DESC",
  deadline: "DEADLINE_ASC",
} as const;

export type SortKey = keyof typeof SORTS;

export interface SearchArgs {
  query?: string;
  area?: string[];
  role?: string[];
  industry?: string[];
  extent?: string;
  remote?: string;
  sector?: string;
  employment_type?: string[];
  experience?: string[];
  education?: string[];
  language?: string;
  published_within_days?: number;
  deadline_within_days?: number;
  manager_role?: string;
  sort?: SortKey;
  page?: number;
  limit?: number;
}

/** The maximum `rows` FINN honours per request. */
const MAX_ROWS = 50;

export interface BuiltQuery {
  params: URLSearchParams;
  resolved: { filter: FilterName; options: ResolvedOption[] }[];
}

export async function buildQuery(args: SearchArgs): Promise<BuiltQuery> {
  const params = new URLSearchParams();
  const resolved: BuiltQuery["resolved"] = [];

  const addMulti = async (
    filter: FilterName,
    values: string[] | undefined,
    withAliases = false,
  ): Promise<void> => {
    if (!values?.length) return;
    const options = await Promise.all(
      values.map((v) =>
        withAliases
          ? taxonomy.resolveWithAliases(filter, v)
          : taxonomy.resolveOption(filter, v),
      ),
    );
    for (const option of options) params.append(filter, option.value);
    resolved.push({ filter, options });
  };

  if (args.query?.trim()) params.set("q", args.query.trim());

  await addMulti("location", args.area);
  await addMulti("occupation", args.role);
  await addMulti("industry", args.industry);
  await addMulti("job_duration", args.employment_type, true);
  await addMulti("work_experience", args.experience, true);
  await addMulti("education", args.education);
  await addMulti("extent", args.extent ? [args.extent] : undefined, true);
  await addMulti("home_office", args.remote ? [args.remote] : undefined, true);
  await addMulti("job_sector", args.sector ? [args.sector] : undefined, true);
  await addMulti("working_language", args.language ? [args.language] : undefined, true);
  await addMulti("manager_role", args.manager_role ? [args.manager_role] : undefined, true);

  // `published` and `applicationdeadline` are plain day counts, not codes.
  if (args.published_within_days != null) {
    params.set("published", String(args.published_within_days));
  }
  if (args.deadline_within_days != null) {
    params.set("applicationdeadline", String(args.deadline_within_days));
  }

  if (args.sort && args.sort !== "relevance") params.set("sort", SORTS[args.sort]);
  if (args.page && args.page > 1) params.set("page", String(args.page));
  params.set("rows", String(Math.min(args.limit ?? 20, MAX_ROWS)));

  return { params, resolved };
}

export async function runSearch(args: SearchArgs): Promise<{
  response: JobSearchResponse;
  params: URLSearchParams;
}> {
  const { params } = await buildQuery(args);
  return { response: await search<JobDoc>(JOBS, params), params };
}

const fmtDate = (ms?: number): string | undefined =>
  ms == null ? undefined : new Date(ms).toISOString().slice(0, 10);

/** Calendar days between then and now, so two ads posted on the same date
 *  never render as "today" and "1 day ago" depending on the hour. */
function daysAgo(ms?: number): string | undefined {
  if (ms == null) return undefined;
  const midnight = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(new Date(ms))) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

async function describeExtras(doc: JobDoc): Promise<string[]> {
  const out: string[] = [];
  for (const extra of doc.extras ?? []) {
    const filter = extra.id as FilterName;
    if (filter !== "work_experience" && filter !== "education") continue;
    const names = await Promise.all(extra.values.map((v) => taxonomy.labelFor(filter, v)));
    const shown = names.filter(Boolean);
    if (shown.length) out.push(`${extra.label}: ${shown.join(", ")}`);
  }
  return out;
}

/** Render one result as a compact markdown block. */
async function renderDoc(doc: JobDoc, index: number): Promise<string> {
  const lines: string[] = [];
  lines.push(`### ${index}. ${doc.heading}`);

  const meta: string[] = [];
  if (doc.company_name) meta.push(`**${doc.company_name}**`);
  if (doc.location) meta.push(doc.location);
  if (doc.job_title && doc.job_title !== doc.heading) meta.push(doc.job_title);
  if (meta.length) lines.push(meta.join(" · "));

  const dates: string[] = [];
  const published = fmtDate(doc.published);
  if (published) dates.push(`published ${published} (${daysAgo(doc.published)})`);
  const deadline = fmtDate(doc.deadline);
  if (deadline) dates.push(`deadline ${deadline}`);
  if (doc.no_of_positions && doc.no_of_positions > 1) {
    dates.push(`${doc.no_of_positions} positions`);
  }
  if (dates.length) lines.push(dates.join(" · "));

  const extras = await describeExtras(doc);
  if (extras.length) lines.push(extras.join(" · "));

  const labels = (doc.labels ?? []).map((l) => l.text).filter(Boolean);
  if (labels.length) lines.push(labels.join(" · "));

  lines.push(`id \`${doc.ad_id}\` — ${doc.canonical_url}`);
  return lines.join("\n");
}

export async function renderResults(
  response: JobSearchResponse,
  params: URLSearchParams,
): Promise<string> {
  const meta = response.metadata ?? {};
  const total = meta.result_size?.group_count;
  const positions = meta.result_size?.match_count;
  const paging = meta.paging;

  const appliedFilters = (meta.selected_filters ?? []).map(
    (f) => `${f.filter_name}: ${f.display_name}`,
  );
  // FINN only echoes `published` back as a chip for "new today"; show any
  // other day window ourselves so the caller can see the whole query.
  const publishedDays = params.get("published");
  if (publishedDays && publishedDays !== "1" && !meta.selected_filters?.some((f) => f.filter_name === "published")) {
    appliedFilters.push(`published: last ${publishedDays} days`);
  }
  const applied = appliedFilters.join(" · ");

  const header: string[] = [];
  const q = params.get("q");
  const count = total ?? response.docs.length;
  header.push(
    `**${count} ${count === 1 ? "ad" : "ads"}**` +
      (positions != null && positions !== total ? ` (${positions} positions)` : "") +
      (q ? ` matching "${q}"` : ""),
  );
  if (applied) header.push(`Filters — ${applied}`);
  if (paging && paging.last > 0) {
    header.push(
      `Page ${paging.current} of ${paging.last}` +
        (paging.current < paging.last ? " — pass `page` to get more" : ""),
    );
  }
  header.push(`Sorted by ${meta.sort ?? "RELEVANCE"}`);
  header.push(`Open in browser: ${webSearchUrl(JOBS, params)}`);

  if (!response.docs.length) {
    return (
      header.join("\n") +
      "\n\nNo ads matched. Try widening the area, dropping a filter, or " +
      "using `list_filter_options` to check the exact filter names."
    );
  }

  const blocks = await Promise.all(response.docs.map((d, i) => renderDoc(d, i + 1)));
  return `${header.join("\n")}\n\n${blocks.join("\n\n")}`;
}
