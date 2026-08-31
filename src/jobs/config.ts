/**
 * The FINN Jobb marketplace: endpoint, filter list and alias table.
 *
 * Everything job-specific that the core modules would otherwise have to know
 * about lives here. A second marketplace is a sibling folder with its own
 * version of this file.
 */

import { createTaxonomy, type Aliases } from "../core/taxonomy.js";
import { SITE, type Marketplace } from "../core/http.js";

/**
 * Note the search key: despite the name, SEARCH_ID_JOB_FULLTIME is the whole
 * jobs index, not just full-time ads — `extent=Deltid` returns part-time ads
 * through it (verified 2026-08-27: 4132 part-time ads nationally). The name is
 * FINN's, and it is misleading rather than limiting.
 */
export const JOBS: Marketplace = {
  apiBase: "https://www.finn.no/job/job-search-page/api",
  searchKey: "SEARCH_ID_JOB_FULLTIME",
  searchPath: "/job/search",
};

/** Canonical URL of one job advert. */
export const adUrl = (adId: string): string => `${SITE}/job/ad/${adId}`;

/**
 * Filter parameter names accepted by the jobs search endpoint, with the value
 * shape each one expects (verified 2026-08-27 against the live `filters`
 * array). Codes are resolved at runtime by `core/taxonomy.ts`, so these are
 * reference only — nothing here is hard-coded into a request.
 *
 *   published             Publisert          days, `1`–`9`
 *   location              Område             `0.20001` (Norge),
 *                                            `1.20001.20061` (county),
 *                                            `2.20001.20016.20318` (municipality)
 *   occupation            Stilling           `0.23` (top), `1.23.2047` (sub)
 *   industry              Bransje            integer, e.g. `8`
 *   education             Utdanning          integer, e.g. `464`
 *   work_experience       Arbeidserfaring    integer, e.g. `457`
 *   extent                Heltid/deltid      `3947` / `3942`
 *   job_duration          Ansettelsesform    integer, e.g. `3951`
 *   job_sector            Sektor             integer, e.g. `1813`
 *   working_language      Arbeidsspråk       `1` (Norsk) / `2` (Engelsk)
 *   home_office           Hjemmekontor       `1` hybrid / `2` remote / `3` onsite
 *   manager_role          Lederkategori      integer, e.g. `6702`
 *   applicationdeadline   Søknadsfrist       days, `1` / `3` / `7`
 *
 * Outside this list the endpoint also takes `q` (free text), `sort`
 * (`RELEVANCE` / `PUBLISHED_DESC` / `DEADLINE_ASC`) and `page` / `rows`
 * (`rows` is capped at 50 by FINN). Repeating a parameter ORs its values.
 */
export const FILTER_NAMES = [
  "published",
  "location",
  "occupation",
  "industry",
  "education",
  "work_experience",
  "extent",
  "job_duration",
  "job_sector",
  "working_language",
  "home_office",
  "manager_role",
  "applicationdeadline",
] as const;

export type FilterName = (typeof FILTER_NAMES)[number];

export const ALIASES: Aliases = {
  extent: {
    full_time: "Heltid",
    part_time: "Deltid",
  },
  home_office: {
    hybrid: "Delvis hjemmekontor",
    remote: "Kun hjemmekontor",
    onsite: "På kontoret",
  },
  job_sector: {
    private: "Privat",
    public: "Offentlig",
    organisation: "Organisasjoner",
    cooperative: "Samvirke",
    franchise: "Franchise/Selvstendig næringsdrivende",
  },
  job_duration: {
    permanent: "Fast",
    temporary: "Vikariat",
    engagement: "Engasjement",
    project: "Prosjekt",
    staffing_agency: "Bemanningsbyrå",
    apprentice: "Lærling",
    self_employed: "Selvstendig næringsdrivende",
    seasonal: "Sommer/Sesong",
    trainee: "Trainee",
  },
  work_experience: {
    none: "Ingen erfaring",
    junior: "Junior",
    experienced: "Erfaren",
    manager: "Leder",
  },
  working_language: {
    norwegian: "Norsk",
    english: "Engelsk",
  },
  manager_role: {
    director: "Direktør",
    manager: "Leder",
    team_lead: "Fagleder",
  },
};

/** The jobs taxonomy, bound to the jobs endpoint. One cache per process. */
export const taxonomy = createTaxonomy<FilterName>(JOBS, ALIASES);
