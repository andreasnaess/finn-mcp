# finn-mcp

MCP servers for browsing [finn.no](https://www.finn.no), one per FINN
marketplace. Each is its own server process with its own tools and filter
taxonomy; they share this repo, a build and the HTTP layer, nothing more.

| Marketplace | Server | Covers |
| --- | --- | --- |
| Jobs | `finn-jobs` | [FINN Jobb](https://www.finn.no/job/search) — every job advert on FINN, filtered by occupation, area, sector and more |

## Setup

Needs Node 20+ (`fetch` and ES2023).

```sh
git clone <repo-url> finn-mcp && cd finn-mcp
npm install          # installs deps and builds, via the prepare script
npm run register     # registers each server with Claude Code, user-scoped
npm run smoke        # check each server starts and list its tools
```

`register` resolves the absolute path from wherever you cloned to, so there is
nothing machine-specific to edit. Re-run it after moving the clone. Pass a name
(`npm run register -- jobs`) for just one, or `-- --print` to emit `mcpServers`
JSON for clients that aren't configured through the `claude` CLI.

## Tools

| Tool | What it does |
| --- | --- |
| `search_jobs` | Search adverts by text, area, job function, industry, seniority, remote policy, publication date and deadline. Filters take plain names, not FINN's numeric codes. |
| `get_job` | One advert in full: description, deadline, employer, skills, apply link, and the employer's "Hva vi tilbyr" list — where salary appears, when an advert states it. |
| `list_filter_options` | Browse FINN's live filter taxonomy, with ad counts. |

## Filtering

`role` and `area` take names, not FINN's numeric codes. `role` is FINN's
*Stilling* filter — 83 top-level occupations covering every trade and
profession on FINN, most of them with children. A parent matches everything
under it, so `["Helsepersonell"]` is broader than `["Sykepleier"]`. `area`
takes any county, municipality or Oslo district. Repeated values are OR-ed.

```jsonc
// Nurses in Bergen, permanent positions
{ "role": ["Sykepleier"], "area": ["Bergen"], "employment_type": ["permanent"] }

// Senior backend/full-stack around Oslo, hybrid, English-speaking
{ "role": ["Backend-utvikler", "Full stack utvikler"], "area": ["Oslo", "Bærum"],
  "experience": ["experienced"], "remote": "hybrid", "language": "english" }

// Anything at all in Tromsø with a deadline this week
{ "area": ["Tromsø"], "deadline_within_days": 7, "sort": "deadline" }
```

Omit `role` and the search covers every advert on FINN; `query` alone works
too, for occupations the taxonomy splits differently than you would.

`list_filter_options` is the source of truth for which values exist — the
taxonomy is read from FINN at request time, so no copy of it belongs here.
Matching ignores case and accents, and the small closed filters (`extent`,
`remote`, `sector`, `employment_type`, `experience`, `language`) also accept
English aliases; see `ALIASES` in `src/jobs/config.ts`.

## How it works

FINN's search pages are React apps calling a public, unauthenticated JSON
endpoint, with the base URL and search key the page itself ships. Every
response carries the complete filter taxonomy, so this server resolves names to
codes at runtime (cached for an hour) instead of baking in codes that go stale
— as FINN's 2024 county renumbering would have. Individual adverts have no JSON
endpoint and are parsed from the ad page.

```
src/
  core/    marketplace-agnostic: HTTP, and the filter-taxonomy engine
  jobs/    the FINN Jobb marketplace: config, tools, search, ad parsing
```

A new marketplace is a sibling of `jobs/` with its own `config.ts` and
`index.ts`, plus a `bin` entry in `package.json`. No marketplace-specific
values live in `core/`.

## Caveats

An undocumented endpoint, not a supported API: it can change without notice.
The runtime taxonomy lookup absorbs value changes; an endpoint change would
need a fix here. Requests go one at a time, with an identifying `User-Agent`,
at browsing volumes.
