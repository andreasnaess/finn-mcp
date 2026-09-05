/**
 * Parsing of a single job ad page (https://www.finn.no/job/ad/<id>).
 *
 * The ad page has no JSON endpoint of its own. Most pages carry a schema.org
 * JobPosting block, which gives us employment type, dates and hiring
 * organisation without guesswork — but ads FINN imports from an employer's own
 * recruitment system have no such block, so the advert body is read from the
 * rendered markup, which every ad has. The
 * remaining fields — FINN's own "key info" strip, the AI-generated summary
 * and skills, the employer fact list — are read from the rendered markup.
 */

import { fetchHtml, SITE } from "../core/http.js";
import { JOBS, adUrl } from "./config.js";

export interface JobAd {
  id: string;
  url: string;
  /** The advert's headline, e.g. "DNB IT Summer Internship 2027". */
  heading?: string;
  /** The formal job title, e.g. "Summer Intern". */
  jobTitle?: string;
  company?: string;
  companyUrl?: string;
  datePosted?: string;
  deadline?: string;
  employmentType?: string[];
  place?: string;
  /** One-line AI summary FINN shows under "Kortversjonen". */
  summary?: string;
  /** AI-extracted skill tags. */
  skills: string[];
  /** FINN's "Hva vi tilbyr" list. Salary, when stated, is an item here. */
  whatWeOffer: string[];
  /** FINN's "Kvalifikasjoner" list. */
  qualifications: string[];
  /** FINN's own keyword line. */
  keywords?: string;
  /** The "key info" strip: Søknadsfrist, Sektor, Antall stillinger, ... */
  keyInfo: Record<string, string>;
  /** The employer fact list: Sted, Bransje, Stillingsfunksjon, ... */
  facts: Record<string, string>;
  /** Full advert text, plain text with paragraph breaks preserved. */
  description?: string;
  applyUrl?: string;
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&(?:nbsp|#160);/g, " ")
    .replace(/&(?:amp|#38);/g, "&")
    .replace(/&(?:lt|#60);/g, "<")
    .replace(/&(?:gt|#62);/g, ">")
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:#0?39|apos|#x27);/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));

/** Strip tags to a single line of text. */
const text = (html: string): string =>
  decodeEntities(html.replace(/<!--.*?-->/gs, "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    // Inline links become spaces, which leaves "Data Scientist , Dataarkitekt".
    .replace(/\s+([,;:.])/g, "$1")
    .trim();

/** Strip tags but keep block structure as newlines — for the advert body. */
const richText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<!--.*?-->/gs, "")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/\s*(p|div|h[1-6]|section|tr)\s*>/gi, "\n\n")
      // Imported adverts leave headings as bare text before the next block
      // ("Om stillingen<p>..."), so opening tags have to break the line too.
      .replace(/<\s*(p|div|h[1-6]|section|ul|ol|table)\b[^>]*>/gi, "\n\n")
      .replace(/<\s*li[^>]*>/gi, "\n- ")
      .replace(/<\/\s*(ul|ol)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * The inner HTML of the balanced `<div>` opening at `openTagStart`.
 *
 * The advert body is nested divs, so a non-greedy `</div>` match would stop at
 * the first child's close. Counting depth is the only correct way to end it.
 */
function innerDiv(html: string, openTagStart: number): string | undefined {
  const bodyStart = html.indexOf(">", openTagStart);
  if (bodyStart < 0) return undefined;
  let depth = 1;
  for (const m of html.slice(bodyStart + 1).matchAll(/<(\/?)div\b/g)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(bodyStart + 1, bodyStart + 1 + m.index);
  }
  return undefined;
}

/**
 * The advert body as rendered on the page.
 *
 * Ads FINN imports from an employer's own recruitment system (`adType`
 * AGGREGATED_JOB) are served from a different template that carries no
 * schema.org block at all, so the JSON-LD description is missing on them.
 * Both templates wrap the advert in `div.import-decoration` — the first such
 * block is the advert, the second is the "om arbeidsgiveren" blurb.
 *
 * This is deliberately the only source. Falling back to the JSON-LD
 * description would let a change to this markup degrade silently on the ads
 * that happen to carry a schema.org block (about 93% of them, and nearly all
 * of the most recently published), which is precisely how the missing bodies
 * went unnoticed before. One source fails loudly, on every ad, and the smoke
 * check catches it.
 */
function parseAdvertBody(html: string): string | undefined {
  const open = /<div[^>]*class="[^"]*\bimport-decoration\b[^"]*"[^>]*>/.exec(html);
  if (!open) return undefined;
  const body = innerDiv(html, open.index);
  if (!body) return undefined;
  const rendered = richText(body);
  return rendered || undefined;
}

/**
 * Employer name from FINN's own tracking payload, which both templates carry.
 * Used when there is no JSON-LD hiringOrganization to read it from.
 */
function parseCompanyName(html: string): string | undefined {
  const m = /"key":"company_name","value":\["([^"]+)"\]/.exec(html);
  return m?.[1] ? decodeEntities(m[1]) : undefined;
}

/**
 * Publication date from the page's embedded ad payload. The payload is a
 * JS string on the aggregated template, so the quotes around the key arrive
 * backslash-escaped; match either shape.
 */
function parseDatePosted(html: string): string | undefined {
  const m = /\\*"datePosted\\*"\s*[:,]\s*\\*"(\d{4}-\d{2}-\d{2})/.exec(html);
  return m?.[1];
}

/** FINN prints dates as dd.mm.yyyy; everything else here is ISO. */
function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : value;
}

interface JobPostingLd {
  "@type"?: string;
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  employmentType?: string[] | string;
  identifier?: string;
  hiringOrganization?: { name?: string; url?: string };
  jobLocation?: { address?: { addressLocality?: string; postalCode?: string } };
}

function findJobPosting(html: string): JobPostingLd | undefined {
  const blocks = html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs,
  );
  for (const block of blocks) {
    const body = block[1];
    if (!body) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    // FINN nests the payload under a "script:ld+json" key on ad pages.
    const record = parsed as Record<string, unknown>;
    const candidate = (record["script:ld+json"] ?? record) as JobPostingLd;
    if (candidate?.["@type"] === "JobPosting") return candidate;
  }
  return undefined;
}

/** `<span ...>Label:</span> value` pairs from the employer fact list. */
function parseFacts(html: string): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const m of html.matchAll(
    /<li[^>]*>\s*<span class="font-bold">(.*?)<\/span>(.*?)<\/li>/gs,
  )) {
    const key = text(m[1] ?? "").replace(/:$/, "");
    const value = text(m[2] ?? "").replace(/^:\s*/, "");
    if (key && value) facts[key] = value;
  }
  return facts;
}

/** The strip of `<span>Label</span> <strong class="key-info-text">Value</strong>`. */
function parseKeyInfo(html: string): Record<string, string> {
  const info: Record<string, string> = {};
  for (const m of html.matchAll(
    /<span[^>]*>([^<]*?)<\/span>\s*<strong class="key-info-text">(.*?)<\/strong>/gs,
  )) {
    const key = text(m[1] ?? "");
    const value = text(m[2] ?? "");
    if (key && value) info[key] = value;
  }
  return info;
}

function parseSection(html: string, headingId: string): string | undefined {
  const start = html.indexOf(headingId);
  if (start < 0) return undefined;
  return html.slice(start);
}

function parseSummary(html: string): string | undefined {
  const region = parseSection(html, 'id="ad-summary-content"');
  if (!region) return undefined;
  const para = /<p class="mb-0">(.*?)<\/p>/s.exec(region);
  return para?.[1] ? text(para[1]) : undefined;
}

/**
 * The bullet list under a card heading. FINN renders "Ferdigheter",
 * "Kvalifikasjoner" and "Hva vi tilbyr" the same way — a heading followed by a
 * `<ul>` — so one reader serves all three. A heading can carry a badge after
 * its label ("Ferdigheter AI-generert"), hence the prefix match rather than
 * an equality check.
 */
function parseBulletSection(html: string, heading: string): string[] {
  for (const m of html.matchAll(/<h([23])[^>]*>(.*?)<\/h\1>/gs)) {
    if (!text(m[2] ?? "").startsWith(heading)) continue;
    const after = html.slice(m.index + m[0].length);
    const list = /^(?:\s|<div[^>]*>)*<ul[^>]*>(.*?)<\/ul>/s.exec(after);
    if (!list?.[1]) continue;
    const items = [...list[1].matchAll(/<li[^>]*>(.*?)<\/li>/gs)]
      .map((li) => text(li[1] ?? ""))
      .filter(Boolean);
    if (items.length) return items;
  }
  return [];
}

function parseKeywords(html: string): string | undefined {
  const m = /Nøkkelord<\/h2>\s*<p[^>]*>(.*?)<\/p>/s.exec(html);
  return m?.[1] ? text(m[1]) : undefined;
}

function parseHeading(html: string): string | undefined {
  // The advert headline is the h1 that is not the formal job title; FINN
  // renders the job title first and the ad heading inside the summary card.
  const headings = [...html.matchAll(/<h1[^>]*>(.*?)<\/h1>/gs)].map((m) =>
    text(m[1] ?? ""),
  );
  const heading = headings.find(Boolean);
  if (heading) return heading;
  const title = /<title>(.*?)<\/title>/s.exec(html);
  return title?.[1] ? text(title[1]).replace(/\s*\|\s*FINN\.no$/, "") : undefined;
}

export function parseAd(id: string, html: string): JobAd {
  const ld = findJobPosting(html);
  const keyInfo = parseKeyInfo(html);
  const facts = parseFacts(html);
  const applyMatch = new RegExp(
    `href="(${SITE.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}/job-apply/[^"]+)"`,
  ).exec(html);

  return {
    id,
    url: adUrl(id),
    heading: parseHeading(html),
    jobTitle: ld?.title,
    company: ld?.hiringOrganization?.name ?? parseCompanyName(html),
    companyUrl: ld?.hiringOrganization?.url,
    datePosted: ld?.datePosted ?? parseDatePosted(html),
    deadline: toIsoDate(keyInfo["Søknadsfrist"]) ?? ld?.validThrough,
    employmentType: ld?.employmentType
      ? Array.isArray(ld.employmentType)
        ? ld.employmentType
        : [ld.employmentType]
      : undefined,
    place: [ld?.jobLocation?.address?.postalCode, ld?.jobLocation?.address?.addressLocality]
      .filter(Boolean)
      .join(" ") || undefined,
    summary: parseSummary(html),
    skills: parseBulletSection(html, "Ferdigheter"),
    whatWeOffer: parseBulletSection(html, "Hva vi tilbyr"),
    qualifications: parseBulletSection(html, "Kvalifikasjoner"),
    keywords: parseKeywords(html),
    keyInfo,
    facts,
    description: parseAdvertBody(html),
    applyUrl: applyMatch?.[1],
  };
}

export async function getAd(id: string): Promise<JobAd> {
  return parseAd(id, await fetchHtml(adUrl(id), `${SITE}${JOBS.searchPath}`));
}

/** Accept an ad id, a finnkode, or a full finn.no URL. */
export function parseAdId(input: string): string {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const m = /(?:finnkode=|\/job\/ad\/|\/ad\.html\?finnkode=)(\d+)/.exec(trimmed);
  if (m?.[1]) return m[1];
  throw new Error(
    `"${input}" is not a FINN ad id or URL. Expected something like 474777851 or https://www.finn.no/job/ad/474777851`,
  );
}
