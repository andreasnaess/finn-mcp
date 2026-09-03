# finn-mcp

MCP servers for browsing [finn.no](https://www.finn.no), one per FINN
marketplace. They share this repo, a build and the HTTP layer, nothing more.

| Marketplace | Server | Covers |
| --- | --- | --- |
| Jobs | `finn-jobs` | [FINN Jobb](https://www.finn.no/job/search) — every job advert on FINN |

## Setup

Node 20+.

```sh
pnpm install          # installs and builds, via the prepare script
pnpm run register     # registers each server with Claude Code
pnpm run smoke        # check each server starts and lists its tools
```

`register` resolves absolute paths itself — re-run it after moving the clone.
Add a name (`-- jobs`) for one server, `-- --print` for `mcpServers` JSON.

## Remote (Cloudflare Workers)

The jobs server also runs as a Worker — same tools, different transport — which
is what a [claude.ai custom connector](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
needs.

```sh
pnpm run worker:dev
pnpm run worker:deploy
```

Add the URL under Settings → Connectors with no auth; the data is public and
read-only (Claude takes a fixed token only via admin-entered `static_headers`).
The Worker rate limits itself instead — 30 req/min per IP, in `wrangler.toml`.
It uses a binding, not a WAF rule: WAF rules need a zone, `workers.dev` is not
one.

## Tools

| Tool | What it does |
| --- | --- |
| `search_jobs` | Search by text, area, job function, industry, seniority, remote policy, publication date and deadline. |
| `get_job` | One advert in full, including the "Hva vi tilbyr" list — where salary appears, when an advert states it. |
| `list_filter_options` | Browse FINN's live filter taxonomy, with ad counts. |

## Filtering

`role` is FINN's *Stilling* filter — 83 top-level occupations covering every
trade and profession, most with children, and a parent matches everything under
it. `area` takes any county, municipality or Oslo district. Repeated values are
OR-ed. Omit `role` and the search covers all of FINN.

```jsonc
// Nurses in Bergen, permanent positions
{ "role": ["Sykepleier"], "area": ["Bergen"], "employment_type": ["permanent"] }

// Senior backend/full-stack around Oslo, hybrid, English-speaking
{ "role": ["Backend-utvikler", "Full stack utvikler"], "area": ["Oslo", "Bærum"],
  "experience": ["experienced"], "remote": "hybrid", "language": "english" }

// Anything at all in Tromsø with a deadline this week
{ "area": ["Tromsø"], "deadline_within_days": 7, "sort": "deadline" }
```

`list_filter_options` is the source of truth for which values exist. Matching
ignores case and accents; the small closed filters also take English aliases
(`ALIASES` in `src/jobs/config.ts`).

## How it works

FINN's search pages call a public JSON endpoint whose base URL and search key
the page itself ships. Every response carries the full filter taxonomy, so names
resolve to codes at runtime (cached an hour) rather than baking in codes that go
stale. Adverts are parsed from the ad page — they have no JSON endpoint.

```
src/
  core/    marketplace-agnostic: HTTP, taxonomy engine
  jobs/    FINN Jobb: config, tools, search, ad parsing
    server.ts   the tools — one factory both entry points call
    index.ts    stdio entry
    worker.ts   HTTP entry
```

A new marketplace is a sibling of `jobs/` with its own `config.ts` and
`server.ts`, plus a `bin` entry. Nothing marketplace-specific in `core/`.

## Caveats

Undocumented endpoints, not a supported API. The runtime taxonomy absorbs value
changes; an endpoint change needs a fix here.

## License

MIT. Covers this code, not FINN's data.
