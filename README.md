# finn-mcp

MCP servers for browsing [finn.no](https://www.finn.no), one per FINN vertical.
Each vertical is a separate server process with its own tools and its own filter
taxonomy; they share this repo, a build and the HTTP layer, nothing more.

| Vertical | Entry point | What it covers |
| --- | --- | --- |
| Jobs | `dist/jobs/index.js` | [FINN Jobb](https://www.finn.no/job/search), Norway's dominant job board — built for finding software developer roles in a given area |

## Layout

```
src/
  core/        vertical-agnostic: HTTP, and the live filter-taxonomy engine
    http.ts      request/timeout/errors; `search(vertical, params)`
    taxonomy.ts  `createTaxonomy(vertical, aliases)` — name→code resolution
  jobs/        the FINN Jobb vertical
    config.ts    endpoint, filter names, English aliases, ad URL
    index.ts     the server: tool registration (this is the bin entry)
    search.ts    parameter assembly and result rendering
    ad.ts        parsing one advert page
```

A new vertical is a sibling folder of `jobs/` with its own `config.ts` and
`index.ts`, plus a `bin` entry in `package.json`. `core/` holds only what is
genuinely shared — no vertical-specific values live there.

## Tools

These are the jobs server's tools.

| Tool | What it does |
| --- | --- |
| `search_jobs` | Search adverts by free text, area, job function, industry, seniority, remote policy, publication date, deadline and more. Filters take plain names, not FINN's numeric codes. |
| `get_job` | Fetch one advert in full: description, deadline, employer, extracted skills, apply link. |
| `list_filter_options` | Browse FINN's live filter taxonomy — every area, job function and industry, with ad counts. |

## Setup

On any machine, from a fresh clone:

```sh
git clone <repo-url> finn-mcp && cd finn-mcp
npm install             # installs deps and builds, via the prepare script
npm run register        # registers each vertical's server with Claude Code
```

`npm run register` resolves the absolute path from wherever you cloned to, so
there is nothing machine-specific to edit. It is safe to re-run — it replaces
any existing registration, which is also how you point Claude Code at a clone
that has moved. Pass a vertical to register just that one:

```sh
npm run register            # every vertical
npm run register -- jobs    # only finn-jobs
```

Under the hood each registration is just:

```sh
claude mcp add finn-jobs -s user -- node "$PWD/dist/jobs/index.js"
```

`-s user` makes the server available in all your projects, which is what you
want for searching FINN from anywhere. It must be an absolute path: a
user-scoped server is launched from whatever directory you happen to be in.

For clients configured by hand rather than through the `claude` CLI, print the
equivalent config instead:

```sh
npm run register -- --print
```

Each vertical is registered separately, named for the vertical it covers
(`finn-jobs`, `finn-torget`, …), so their tools stay distinguishable when
several are registered at once. Adding a second vertical never disturbs the
first: `scripts/register.mjs` derives the list from the `bin` map in
`package.json`, so a new vertical needs a `bin` entry and nothing more.

To check that a server actually starts and to see the tools it exposes:

```sh
npm run smoke
```

```
✓ finn-jobs: finn-jobs-mcp@0.1.0 — 3 tools
    search_jobs
    get_job
    list_filter_options
```

Or add it to `~/.claude.json` by hand — substituting your own clone path:

```json
{
  "mcpServers": {
    "finn-jobs": {
      "command": "node",
      "args": ["/absolute/path/to/finn-mcp/dist/jobs/index.js"]
    }
  }
}
```

Note that Claude Code writes `~/.claude.json` itself, so a hand-edit made while
a session is running can be overwritten; `claude mcp add` goes through the CLI's
own writer and does not have that problem.

## Finding developer jobs

The `role` argument maps to FINN's *Stilling* (job function) filter. `"IT utvikling"`
is the umbrella for software development; the narrower values under it are:

`AI / Maskinlæring` · `App utvikler` · `Backend-utvikler` · `Cloud-utvikler` ·
`Data Scientist` · `Dataarktitekt` · `Database` · `Dataingeniør` ·
`Embedded-utvikler` · `Etisk hacker` · `Front-end` · `Full stack utvikler` ·
`IT-sikkerhet` · `Løsningsarkitekt` · `MLOps-ingeniør` · `QA/Testing` ·
`Sikkerhetsanalytiker` · `Systemarkitekt` · `Tech Lead` · `Utvikler (generell)`

Related functions live elsewhere in the taxonomy: `IT drift og vedlikehold`
(ops/support), `Design` → `UX-design`, `Ingeniør` → `Kybernetikk`.

`area` accepts any Norwegian county, municipality or Oslo district by name —
`"Oslo"`, `"Bergen"`, `"Trøndelag"`, `"Bærum"`, `"Grünerløkka"`. Multiple areas
or roles are OR-ed together.

Example calls:

```jsonc
// All software development in and around Trondheim, newest first
{ "role": ["IT utvikling"], "area": ["Trondheim"], "sort": "published" }

// Senior backend/full-stack in the Oslo area, hybrid, English-speaking
{ "role": ["Backend-utvikler", "Full stack utvikler"],
  "area": ["Oslo", "Bærum"], "experience": ["experienced"],
  "remote": "hybrid", "language": "english" }

// Anything mentioning Kotlin posted in the last week
{ "query": "kotlin", "published_within_days": 7, "sort": "published" }
```

English aliases are accepted for the small closed-vocabulary filters —
`extent` (`full_time`/`part_time`), `remote` (`hybrid`/`remote`/`onsite`),
`sector` (`private`/`public`/…), `employment_type` (`permanent`/`temporary`/…),
`experience` (`none`/`junior`/`experienced`/`manager`), `language`
(`norwegian`/`english`). The Norwegian display names work too, and matching is
case- and accent-insensitive, so `"backend utvikler"` finds `Backend-utvikler`.

## How it works

FINN's job search page is a React app that calls a public, unauthenticated JSON
endpoint. The base URL and search key are the ones the page itself ships in its
`data-props` payload:

```
GET https://www.finn.no/job/job-search-page/api/unified-search/SEARCH_ID_JOB_FULLTIME?<filters>
```

Despite its name, `SEARCH_ID_JOB_FULLTIME` is the whole jobs index rather than
just full-time ads — `extent=Deltid` returns part-time ads through it (verified
2026-08-27: 4132 part-time ads nationally). Other verticals have their own base
URL and search key; those two values are all `core/` needs to talk to them.

Every response carries a `filters` array containing the complete taxonomy —
display names paired with the codes the query parameters expect. This server
reads its codes from there at runtime (cached for an hour) rather than baking
them in, so a FINN taxonomy change is picked up automatically instead of
silently returning nothing. That matters: the 2024 county reform renumbered
Norwegian counties, and a hard-coded table would have gone stale.

Individual adverts (`get_job`) have no JSON endpoint. They are read from the ad
page's schema.org `JobPosting` block for the body text, dates and employer, plus
targeted extraction of FINN's own key-info strip, AI summary and skill tags.

### Query parameters, for reference

| Parameter | Filter | Value shape |
| --- | --- | --- |
| `q` | free text | string |
| `location` | Område | `0.20001` (Norge), `1.20001.20061` (county), `2.20001.20016.20318` (municipality) |
| `occupation` | Stilling | `0.23` (top level), `1.23.2047` (sub-level) |
| `industry` | Bransje | integer, e.g. `8` |
| `education` | Utdanning | integer, e.g. `464` |
| `work_experience` | Arbeidserfaring | integer, e.g. `457` |
| `extent` | Heltid/deltid | `3947` / `3942` |
| `job_duration` | Ansettelsesform | integer, e.g. `3951` |
| `job_sector` | Sektor | integer, e.g. `1813` |
| `working_language` | Arbeidsspråk | `1` (Norsk) / `2` (Engelsk) |
| `home_office` | Hjemmekontor | `1` hybrid / `2` remote / `3` onsite |
| `manager_role` | Lederkategori | integer, e.g. `6702` |
| `published` | Publisert | days, `1`–`9` |
| `applicationdeadline` | Søknadsfrist | days, `1` / `3` / `7` |
| `sort` | — | `RELEVANCE` / `PUBLISHED_DESC` / `DEADLINE_ASC` |
| `page`, `rows` | paging | `rows` is capped at 50 by FINN |

Repeating a parameter ORs the values together.

## Caveats

This is an undocumented endpoint, not a supported API. It can change without
notice; the runtime taxonomy lookup absorbs value changes, but a change to the
endpoint itself would need a fix here. Requests are made one at a time with an
identifying `User-Agent`, at browsing volumes.
