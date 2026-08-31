# finn-mcp

MCP servers for browsing [finn.no](https://www.finn.no), one per FINN
marketplace. Each is its own server process with its own tools and filter
taxonomy; they share this repo, a build and the HTTP layer, nothing more.

| Marketplace | Server | Covers |
| --- | --- | --- |
| Jobs | `finn-jobs` | [FINN Jobb](https://www.finn.no/job/search) — built for finding developer roles in a given area |

## Setup

Needs Node 20+ (`fetch` and ES2023). Developed on Node 25 / npm 11.

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
| `get_job` | One advert in full: description, deadline, employer, skills, apply link. |
| `list_filter_options` | Browse FINN's live filter taxonomy, with ad counts. |

## Finding developer jobs

`role` maps to FINN's *Stilling* filter. `"IT utvikling"` is the umbrella for
software development; under it sit `AI / Maskinlæring` · `App utvikler` ·
`Backend-utvikler` · `Cloud-utvikler` · `Data Scientist` · `Dataarktitekt` ·
`Database` · `Dataingeniør` · `Embedded-utvikler` · `Etisk hacker` ·
`Front-end` · `Full stack utvikler` · `IT-sikkerhet` · `Løsningsarkitekt` ·
`MLOps-ingeniør` · `QA/Testing` · `Sikkerhetsanalytiker` · `Systemarkitekt` ·
`Tech Lead` · `Utvikler (generell)`. Related work sits elsewhere in the tree:
`IT drift og vedlikehold`, `Design` → `UX-design`, `Ingeniør` → `Kybernetikk`.

`area` takes any county, municipality or Oslo district by name (`"Oslo"`,
`"Trøndelag"`, `"Bærum"`, `"Grünerløkka"`). Repeated areas or roles are OR-ed.

```jsonc
// All software development around Trondheim, newest first
{ "role": ["IT utvikling"], "area": ["Trondheim"], "sort": "published" }

// Senior backend/full-stack in Oslo, hybrid, English-speaking
{ "role": ["Backend-utvikler", "Full stack utvikler"],
  "area": ["Oslo", "Bærum"], "experience": ["experienced"],
  "remote": "hybrid", "language": "english" }
```

English aliases work for the small closed filters — `extent`, `remote`,
`sector`, `employment_type`, `experience`, `language` (see `ALIASES` in
`src/jobs/config.ts`). Norwegian display names work too, and matching ignores
case and accents, so `"backend utvikler"` finds `Backend-utvikler`.

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
