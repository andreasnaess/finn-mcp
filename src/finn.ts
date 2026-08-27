/**
 * Low-level HTTP access to finn.no.
 *
 * FINN's job search page (https://www.finn.no/job/search) is a React app that
 * talks to a public, unauthenticated JSON endpoint. The base URL and search key
 * are the ones the page itself ships in its `data-props` payload:
 *
 *   <script type="application/json" data-props>  (base64)
 *     { "apiUrl": "https://www.finn.no/job/job-search-page/api",
 *       "searchKey": "SEARCH_ID_JOB_FULLTIME", ... }
 *
 * and the client bundle (job-search-web/entry.client.js) builds requests as
 * `${apiUrl}/unified-search/${searchKey}?<params>`.
 *
 * There is no documented public API contract here, so everything this module
 * depends on is re-verified at runtime where practical: filter codes are read
 * from the `filters` array the API returns rather than hard-coded.
 */

export const API_BASE = "https://www.finn.no/job/job-search-page/api";
export const SEARCH_KEY = "SEARCH_ID_JOB_FULLTIME";
export const SITE = "https://www.finn.no";

/** Identify the client honestly; FINN blocks obviously headless/blank agents. */
const USER_AGENT =
  "finn-mcp/0.1 (MCP server for finn.no job search; +https://github.com/)";

const DEFAULT_TIMEOUT_MS = 20_000;

export class FinnError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FinnError";
  }
}

async function request(url: string, accept: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: accept,
        "Accept-Language": "nb-NO,nb;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      throw new FinnError(
        `finn.no returned HTTP ${res.status} for ${url}`,
        res.status,
      );
    }
    return res;
  } catch (err) {
    if (err instanceof FinnError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new FinnError(`Request to finn.no timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    }
    throw new FinnError(`Request to finn.no failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** A single result row from the search API. */
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

export interface FilterItem {
  display_name: string;
  value: string | number;
  hits?: number;
  filter_items?: FilterItem[];
}

export interface FilterGroup {
  name: string;
  display_name?: string;
  filter_items?: FilterItem[];
}

export interface SearchResponse {
  docs: JobDoc[];
  filters: FilterGroup[];
  metadata: {
    params: Record<string, string[]>;
    result_size?: { match_count?: number; group_count?: number };
    paging?: { param: string; current: number; last: number };
    sort?: string;
    title?: string;
    selected_filters?: {
      filter_name: string;
      display_name: string;
      parameters: { parameter_name: string; parameter_value: string }[];
    }[];
  };
}

/** Call the unified-search endpoint. `params` values are passed through as-is. */
export async function search(
  params: URLSearchParams,
): Promise<SearchResponse> {
  const url = `${API_BASE}/unified-search/${SEARCH_KEY}?${params.toString()}`;
  const res = await request(url, "application/json");
  return (await res.json()) as SearchResponse;
}

/** Fetch the HTML of a single job ad page. */
export async function fetchAdHtml(adId: string): Promise<string> {
  const res = await request(`${SITE}/job/ad/${adId}`, "text/html");
  return await res.text();
}

/** Build the human-facing search URL that matches a set of API params. */
export function webSearchUrl(params: URLSearchParams): string {
  const web = new URLSearchParams(params);
  web.delete("rows");
  return `${SITE}/job/search?${web.toString()}`;
}
