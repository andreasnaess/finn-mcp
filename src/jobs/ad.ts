/**
 * Parsing of a single job ad page (https://www.finn.no/job/ad/<id>).
 *
 * The ad page has no JSON endpoint of its own, but it does carry a
 * schema.org JobPosting block, which gives us the full advert body,
 * employment type, dates and hiring organisation without guesswork. The
 * remaining fields — FINN's own "key info" strip, the AI-generated summary
 * and skills, the employer fact list — are read from the rendered markup.
 */

import { fetchHtml, SITE } from "../core/http.js";
import { adUrl } from "./config.js";

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
      .replace(/<\s*li[^>]*>/gi, "\n- ")
      .replace(/<\/\s*(ul|ol)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

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

function parseSkills(html: string): string[] {
  const idx = html.indexOf("Ferdigheter");
  if (idx < 0) return [];
  const region = html.slice(idx, idx + 6000);
  const list = /<ul[^>]*>(.*?)<\/ul>/s.exec(region);
  if (!list?.[1]) return [];
  return [...list[1].matchAll(/<span class="truncate whitespace-nowrap">(.*?)<\/span>/gs)]
    .map((m) => text(m[1] ?? ""))
    .filter(Boolean);
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
    company: ld?.hiringOrganization?.name,
    companyUrl: ld?.hiringOrganization?.url,
    datePosted: ld?.datePosted,
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
    skills: parseSkills(html),
    keywords: parseKeywords(html),
    keyInfo,
    facts,
    description: ld?.description ? richText(ld.description) : undefined,
    applyUrl: applyMatch?.[1],
  };
}

export async function getAd(id: string): Promise<JobAd> {
  return parseAd(id, await fetchHtml(adUrl(id)));
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
