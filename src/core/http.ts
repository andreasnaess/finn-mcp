/**
 * Low-level HTTP access to finn.no, shared by every marketplace.
 *
 * FINN's search pages are React apps that talk to public, unauthenticated JSON
 * endpoints. Each marketplace ships its own base URL and search key in the
 * page's `data-props` payload:
 *
 *   <script type="application/json" data-props>  (base64)
 *     { "apiUrl": "https://www.finn.no/job/job-search-page/api",
 *       "searchKey": "SEARCH_ID_JOB_FULLTIME", ... }
 *
 * and the client bundle builds requests as
 * `${apiUrl}/unified-search/${searchKey}?<params>`. Those two values are the
 * only things that differ between marketplaces at this layer, so they are
 * passed in as a `Marketplace` rather than hard-coded here.
 *
 * There is no documented public API contract here, so everything this module
 * depends on is re-verified at runtime where practical: filter codes are read
 * from the `filters` array the API returns rather than hard-coded.
 */

export const SITE = "https://www.finn.no";

/**
 * One marketplace's endpoint coordinates — all `core/` needs to talk to it.
 * See `jobs/config.ts` for an example.
 */
export interface Marketplace {
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

/**
 * Statuses worth a second attempt. 403 is in here because finn.no serves one
 * sporadically to datacenter IPs — harmless from a laptop, but the Worker
 * egresses from Cloudflare and sees it often enough to matter. A retry turns
 * that into a success; a real block would fail all attempts alike.
 */
const RETRY_STATUSES = new Set([403, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500];

async function request(
  url: string,
  accept: string,
  referer: string,
  cacheTtlSeconds?: number,
): Promise<Response> {
  for (const delay of RETRY_DELAYS_MS) {
    try {
      return await attempt(url, accept, referer, cacheTtlSeconds);
    } catch (err) {
      if (!(err instanceof FinnError) || !RETRY_STATUSES.has(err.status ?? 0)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return attempt(url, accept, referer, cacheTtlSeconds);
}

async function attempt(
  url: string,
  accept: string,
  referer: string,
  cacheTtlSeconds?: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: accept,
        "Accept-Language": "nb-NO,nb;q=0.9,en;q=0.8",
        // This endpoint exists to be called from the marketplace's own search
        // page, and a browser calling it always says so. Omitting the header
        // made every request look like it came from nowhere. It is not a
        // disguise — the User-Agent above still says exactly who this is — it
        // is the true origin of the call, which we were simply not sending.
        Referer: referer,
      },
      signal: controller.signal,
      redirect: "follow",
      // Ignored off-Workers, and — measured, not assumed — ignored on
      // workers.dev too: `cf-cache-status` comes back BYPASS on every
      // subrequest, because a functional Cache API needs a zone and a
      // workers.dev subdomain is not one. The same gap that keeps WAF rules
      // out (see wrangler.toml) keeps the cache out.
      //
      // So this buys nothing today and every cold isolate reaches finn.no
      // directly. It is kept because it starts working the moment the Worker
      // moves to a custom domain, which is the fix for the 403s rather than a
      // workaround for them. Until then, callers must assume no sharing: see
      // `mayFetchToDescribe` in jobs/server.ts, which is why tool descriptions
      // no longer pay a request per isolate.
      //
      // Per status, never a flat cacheTtl: that cached finn.no's sporadic 403
      // too, and then served it from cache — instantly, for the full hour, to
      // every isolate in the colo. The negative TTL keeps errors uncached, so
      // a retry actually reaches finn.no again.
      ...(cacheTtlSeconds
        ? {
            cf: {
              cacheEverything: true,
              cacheTtlByStatus: { "200-299": cacheTtlSeconds, "300-599": -1 },
            },
          }
        : {}),
    });
    if (!res.ok) {
      // Failures only — a healthy request logs nothing. stderr, not stdout:
      // stdout is the JSON-RPC stream on the stdio server. Read it on Workers
      // with `wrangler tail`. cf-cache tells a refusal from finn.no (MISS or
      // DYNAMIC) apart from one being replayed out of Cloudflare's cache.
      console.error(
        `[finn] ${res.status} ${Date.now() - started}ms ` +
          `cf-cache=${res.headers.get("cf-cache-status") ?? "-"} ${url}`,
      );
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
 * marketplaces; only the shape of a result row differs, so `Doc` is left to
 * the marketplace (see `JobDoc` in `jobs/search.ts`).
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

/**
 * Call a marketplace's unified-search endpoint. `params` are passed through
 * as-is.
 */
export async function search<Doc>(
  marketplace: Marketplace,
  params: URLSearchParams,
  cacheTtlSeconds?: number,
): Promise<SearchResponse<Doc>> {
  const { apiBase, searchKey } = marketplace;
  const url = `${apiBase}/unified-search/${searchKey}?${params.toString()}`;
  const res = await request(url, "application/json", `${SITE}${marketplace.searchPath}`, cacheTtlSeconds);
  return (await res.json()) as SearchResponse<Doc>;
}

/** Fetch the HTML of a single page on finn.no. Adverts are reached from a
 *  search, so that is the referer a browser would carry here too. */
export async function fetchHtml(url: string, referer: string): Promise<string> {
  const res = await request(url, "text/html", referer);
  return await res.text();
}

/** Build the human-facing search URL that matches a set of API params. */
export function webSearchUrl(
  marketplace: Marketplace,
  params: URLSearchParams,
): string {
  const web = new URLSearchParams(params);
  web.delete("rows");
  return `${SITE}${marketplace.searchPath}?${web.toString()}`;
}
