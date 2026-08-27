/**
 * The FINN Jobb vertical: endpoint, filter list and alias table.
 *
 * Everything job-specific that the core modules would otherwise have to know
 * about lives here. A second vertical is a sibling folder with its own version
 * of this file.
 */

import { createTaxonomy, type Aliases } from "../core/taxonomy.js";
import { SITE, type Vertical } from "../core/http.js";

/**
 * Note the search key: despite the name, SEARCH_ID_JOB_FULLTIME is the whole
 * jobs index, not just full-time ads — `extent=Deltid` returns part-time ads
 * through it (verified 2026-08-27: 4132 part-time ads nationally). The name is
 * FINN's, and it is misleading rather than limiting.
 */
export const JOBS: Vertical = {
  apiBase: "https://www.finn.no/job/job-search-page/api",
  searchKey: "SEARCH_ID_JOB_FULLTIME",
  searchPath: "/job/search",
};

/** Canonical URL of one job advert. */
export const adUrl = (adId: string): string => `${SITE}/job/ad/${adId}`;

/** Filter parameter names accepted by the jobs search endpoint. */
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
