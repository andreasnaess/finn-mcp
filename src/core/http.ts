/**
 * Low-level HTTP access to finn.no, shared by every vertical.
 *
 * FINN's search pages are React apps that talk to public, unauthenticated JSON
 * endpoints. Each vertical ships its own base URL and search key in the page's
 * `data-props` payload:
 *
 *   <script type="application/json" data-props>  (base64)
 *     { "apiUrl": "https://www.finn.no/job/job-search-page/api",
 *       "searchKey": "SEARCH_ID_JOB_FULLTIME", ... }
 *
 * and the client bundle builds requests as
 * `${apiUrl}/unified-search/${searchKey}?<params>`. Those two values are the
 * only things that differ between verticals at this layer, so they are passed
 * in as a `Vertical` rather than hard-coded here.
 *
 * There is no documented public API contract here, so everything this module
 * depends on is re-verified at runtime where practical: filter codes are read
 * from the `filters` array the API returns rather than hard-coded.
 */

export const SITE = "https://www.finn.no";

/** The per-vertical endpoint coordinates. See `jobs/config.ts` for an example. */
export interface Vertical {
  /** Search API base, e.g. "https://www.finn.no/job/job-search-page/api". */
  apiBase: string;
  /** Search key the client bundle uses, e.g. "SEARCH_ID_JOB_FULLTIME". */
  searchKey: string;
  /** Human-facing search page path, e.g. "/job/search". */
  searchPath: string;
}

/** Identify the client honestly; FINN blocks obviously headless/blank agents. */
const USER_AGENT =
  "finn-mcp/0.1 (MCP server for finn.no search; +https://github.com/)";

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

/**
 * A search response. The `filters` and `metadata` envelope is the same across
 * verticals; only the shape of a result row differs, so `Doc` is left to the
 * vertical (see `JobDoc` in `jobs/search.ts`).
 */
export interface SearchResponse<Doc> {
  docs: Doc[];
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

/** Call a vertical's unified-search endpoint. `params` are passed through as-is. */
export async function search<Doc>(
  vertical: Vertical,
  params: URLSearchParams,
): Promise<SearchResponse<Doc>> {
  const url = `${vertical.apiBase}/unified-search/${vertical.searchKey}?${params.toString()}`;
  const res = await request(url, "application/json");
  return (await res.json()) as SearchResponse<Doc>;
}

/** Fetch the HTML of a single page on finn.no. */
export async function fetchHtml(url: string): Promise<string> {
  const res = await request(url, "text/html");
  return await res.text();
}

/** Build the human-facing search URL that matches a set of API params. */
export function webSearchUrl(vertical: Vertical, params: URLSearchParams): string {
  const web = new URLSearchParams(params);
  web.delete("rows");
  return `${SITE}${vertical.searchPath}?${web.toString()}`;
}
