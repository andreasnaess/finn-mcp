# finn-mcp

An MCP server for browsing job adverts on [finn.no](https://www.finn.no/job/search)
(FINN Jobb, Norway's dominant job board) — built for finding software developer
roles in a given area.

## Tools

| Tool | What it does |
| --- | --- |
| `search_jobs` | Search adverts by free text, area, job function, industry, seniority, remote policy, publication date, deadline and more. Filters take plain names, not FINN's numeric codes. |
| `get_job` | Fetch one advert in full: description, deadline, employer, extracted skills, apply link. |
| `list_filter_options` | Browse FINN's live filter taxonomy — every area, job function and industry, with ad counts. |

## Setup

```sh
npm install
npm run build
```

Then register it with Claude Code:

```sh
claude mcp add finn --scope user -- node /Users/andreas/projects/finn-mcp/dist/index.js
```

Or add it to `.mcp.json` / `~/.claude.json` by hand:

```json
{
  "mcpServers": {
    "finn": {
      "command": "node",
      "args": ["/Users/andreas/projects/finn-mcp/dist/index.js"]
    }
  }
}
```

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
