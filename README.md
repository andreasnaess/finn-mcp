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
| `get_job` | One advert in full: description, deadline, employer, skills, apply link. |
| `list_filter_options` | Browse FINN's live filter taxonomy, with ad counts. |

## Filtering by role and area

`role` maps to FINN's *Stilling* filter, which spans every occupation on FINN,
not just IT — 83 top-level values over ~27 000 live adverts (counts read
2026-09-03):

`Agronom` · `Analyse` · `Arkitekt og planlegging` · `Arkivar og bibliotekar` ·
`Barnehage` · `Barnevernspedagog` · `Biolog` · `Brannvern` ·
`Brukerstøtte/support` · `Butikkansatt` · `Butikksjef` · `Design` ·
`Dokumentasjon` · `Driftsoperatør/vaktmester` · `Forhandling` ·
`Forretningsutvikling og strategi` · `Forskning/Stipendiat/Postdoktor` ·
`Foto, lyd og lys` · `Franchise` · `Frisør` · `Geologi/Fysikk/Kjemi` ·
`Helsepersonell` · `HMS` · `Hotell og overnatting` ·
`HR, personal og rekruttering` · `Hudpleie og Massasje` · `Håndverker` ·
`Ingeniør` · `Innkjøp/forhandling` · `IT drift og vedlikehold` ·
`IT utvikling` · `Journalist` · `Jurist` · `Konsulent` ·
`Kontor og administrasjon` · `Koordinering` · `Kultur og museum` ·
`Kundeservice` · `Kurs og opplæring` · `Kvalitetssikring` · `Ledelse` · `Lege` ·
`Logistikk og lager` · `Markedsfører` · `Maskinfører og -operatør` ·
`Mat og servering` · `Megler` · `Mekanikk og installasjon` · `Menighetsarbeid` ·
`Militært personell` · `Omsorg og sosialt arbeid` · `Pilot og flypersonell` ·
`Planlegger` · `Politi` · `PR og informasjon` · `Prest` · `Produksjon` ·
`Produktledelse` · `Prosjektledelse` · `Renhold` · `Revisjon og kontroll` ·
`Rådgivning` · `Saksbehandler` · `Salg` · `Salgsledelse` · `Samfunnsviter` ·
`Sikkerhet` · `Sjøfart` · `Sosionom` · `Sykepleier` · `Teknisk personell` ·
`Teknisk service` · `Teknisk tegner` · `Tekstforfatter` · `Tolk/oversetter` ·
`Transport og sjåfør` · `Trener / Personlig trener` ·
`Undervisning og pedagogikk` · `Utøvende kunst` · `Vakt og sikkerhet` ·
`Veterinær og dyrepleier` · `Økonomi og regnskap` · `Annet`

Most of those have children — `Sykepleier` → `Intensivsykepleier`, `Håndverker`
→ `Elektriker`, `Undervisning og pedagogikk` → `Lærer barneskole`. A parent
matches everything under it, so `["Helsepersonell"]` is broader than
`["Sykepleier"]`. Call `list_filter_options` with `filter: "occupation"` for the
live tree with ad counts, and `contains` to narrow it — the taxonomy is read
from FINN at request time, so the list above is a snapshot and the tool is the
source of truth.

`area` takes any county, municipality or Oslo district by name (`"Oslo"`,
`"Trøndelag"`, `"Bærum"`, `"Grünerløkka"`). Repeated areas or roles are OR-ed.

```jsonc
// Nurses in Bergen, permanent positions
{ "role": ["Sykepleier"], "area": ["Bergen"], "employment_type": ["permanent"] }

// Teaching jobs in Trøndelag, newest first
{ "role": ["Undervisning og pedagogikk"], "area": ["Trøndelag"], "sort": "published" }

// Anything at all in Tromsø with a deadline this week
{ "area": ["Tromsø"], "deadline_within_days": 7, "sort": "deadline" }
```

Leave `role` out entirely and the search covers all 27 000 adverts; `query` alone
works too, for occupations the taxonomy splits differently than you would.

### Software development

`"IT utvikling"` is the umbrella; under it sit `AI / Maskinlæring` ·
`App utvikler` · `Backend-utvikler` · `Cloud-utvikler` · `Data Scientist` ·
`Dataarktitekt` · `Database` · `Dataingeniør` · `Embedded-utvikler` ·
`Etisk hacker` · `Front-end` · `Full stack utvikler` · `IT-sikkerhet` ·
`Løsningsarkitekt` · `MLOps-ingeniør` · `QA/Testing` · `Sikkerhetsanalytiker` ·
`Systemarkitekt` · `Tech Lead` · `Utvikler (generell)`. Related work sits
elsewhere in the tree: `IT drift og vedlikehold`, `Brukerstøtte/support`,
`Design` → `UX-design`, `Ingeniør` → `Kybernetikk`.

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
