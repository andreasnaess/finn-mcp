#!/usr/bin/env node
/**
 * finn-mcp — an MCP server for browsing job ads on finn.no (FINN Jobb).
 *
 * Three tools:
 *   search_jobs         — the main search, with human-readable filter names
 *   get_job             — the full text of one advert
 *   list_filter_options — browse FINN's live filter taxonomy
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getAd, parseAdId, type JobAd } from "./ad.js";
import { FinnError } from "./finn.js";
import { renderResults, runSearch, SORTS, type SearchArgs } from "./search.js";
import {
  ALIASES,
  FILTER_NAMES,
  optionsFor,
  UnknownOptionError,
  type FilterName,
  type ResolvedOption,
} from "./taxonomy.js";

const server = new McpServer({ name: "finn-mcp", version: "0.1.0" });

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] });
const errorResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/** Turn expected failures into readable tool errors instead of stack traces. */
async function guard(fn: () => Promise<string>) {
  try {
    return textResult(await fn());
  } catch (err) {
    if (err instanceof UnknownOptionError) return errorResult(err.message);
    if (err instanceof FinnError) return errorResult(err.message);
    return errorResult(`finn-mcp failed: ${(err as Error).message}`);
  }
}

const aliasList = (filter: string): string =>
  Object.keys(ALIASES[filter] ?? {}).join(" | ");

server.registerTool(
  "search_jobs",
  {
    title: "Search FINN job ads",
    description:
      "Search job adverts on finn.no (FINN Jobb, Norway). Filters take " +
      "human-readable names — Norwegian display names as FINN spells them, or " +
      "the English aliases listed per argument — and are matched " +
      "case- and accent-insensitively.\n\n" +
      "For software development roles, the `role` argument is the one that " +
      'matters: "IT utvikling" covers all of it, and narrower values include ' +
      '"Backend-utvikler", "Front-end", "Full stack utvikler", ' +
      '"Utvikler (generell)", "App utvikler", "Cloud-utvikler", ' +
      '"Embedded-utvikler", "AI / Maskinlæring", "Data Scientist", ' +
      '"Dataingeniør", "Systemarkitekt", "Løsningsarkitekt", "Tech Lead", ' +
      '"IT-sikkerhet", "QA/Testing". Use `area` for the location — any ' +
      "Norwegian county, municipality or Oslo district by name. Call " +
      "list_filter_options to see every available value.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Free-text search, e.g. 'kotlin' or 'senior backend'. Norwegian works best."),
      area: z
        .array(z.string())
        .optional()
        .describe(
          "Locations by name: a county ('Vestland'), a municipality ('Bergen', " +
            "'Trondheim', 'Bærum'), or an Oslo district ('Grünerløkka'). " +
            "Multiple areas are OR-ed together.",
        ),
      role: z
        .array(z.string())
        .optional()
        .describe(
          "Job function (FINN's 'Stilling' filter), e.g. 'IT utvikling' or " +
            "'Backend-utvikler'. Multiple roles are OR-ed together.",
        ),
      industry: z
        .array(z.string())
        .optional()
        .describe("Industry (FINN's 'Bransje'), e.g. 'IT - programvare', 'IT', 'Konsulent og rådgivning'."),
      extent: z.string().optional().describe(`Working hours: ${aliasList("extent")}`),
      remote: z
        .string()
        .optional()
        .describe(`Remote work policy: ${aliasList("home_office")}`),
      sector: z.string().optional().describe(`Sector: ${aliasList("job_sector")}`),
      employment_type: z
        .array(z.string())
        .optional()
        .describe(`Type of engagement: ${aliasList("job_duration")}`),
      experience: z
        .array(z.string())
        .optional()
        .describe(`Seniority: ${aliasList("work_experience")}`),
      education: z
        .array(z.string())
        .optional()
        .describe("Required education, e.g. 'Høyskole/universitet, høyere nivå'."),
      language: z
        .string()
        .optional()
        .describe(`Working language: ${aliasList("working_language")}`),
      published_within_days: z
        .number()
        .int()
        .min(1)
        .max(9)
        .optional()
        .describe("Only ads published in the last N days (1-9)."),
      deadline_within_days: z
        .number()
        .int()
        .min(1)
        .max(7)
        .optional()
        .describe("Only ads whose application deadline is within N days (1, 3 or 7)."),
      manager_role: z
        .string()
        .optional()
        .describe(`Management level: ${aliasList("manager_role")}`),
      sort: z
        .enum(Object.keys(SORTS) as [SortKeyName, ...SortKeyName[]])
        .optional()
        .describe("Result order. Defaults to relevance."),
      page: z.number().int().min(1).optional().describe("1-based page number."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Results per page, up to 50 (FINN's own cap). Defaults to 20."),
    },
  },
  async (args) =>
    guard(async () => {
      const { response, params } = await runSearch(args as SearchArgs);
      return renderResults(response, params);
    }),
);

type SortKeyName = keyof typeof SORTS;

function renderAd(ad: JobAd): string {
  const lines: string[] = [];
  lines.push(`# ${ad.heading ?? ad.jobTitle ?? `Ad ${ad.id}`}`);

  const meta: string[] = [];
  if (ad.company) meta.push(`**${ad.company}**`);
  if (ad.place) meta.push(ad.place);
  if (ad.jobTitle && ad.jobTitle !== ad.heading) meta.push(`Title: ${ad.jobTitle}`);
  if (meta.length) lines.push(meta.join(" · "));

  const dates: string[] = [];
  if (ad.datePosted) dates.push(`Published ${ad.datePosted}`);
  if (ad.deadline) dates.push(`Deadline ${ad.deadline}`);
  if (ad.employmentType?.length) dates.push(ad.employmentType.join(", "));
  if (dates.length) lines.push(dates.join(" · "));

  lines.push(`${ad.url}`);
  if (ad.applyUrl) lines.push(`Apply: ${ad.applyUrl}`);
  if (ad.companyUrl) lines.push(`Employer site: ${ad.companyUrl}`);

  if (ad.summary) lines.push(`\n## Summary (FINN's AI-generated "Kortversjonen")\n${ad.summary}`);
  if (ad.skills.length) lines.push(`\n## Skills (AI-extracted)\n${ad.skills.join(", ")}`);

  const details = { ...ad.keyInfo, ...ad.facts };
  const detailLines = Object.entries(details).map(([k, v]) => `- ${k}: ${v}`);
  if (detailLines.length) lines.push(`\n## Key information\n${detailLines.join("\n")}`);

  if (ad.keywords) lines.push(`\n## Keywords\n${ad.keywords}`);
  if (ad.description) lines.push(`\n## Advert\n${ad.description}`);

  return lines.join("\n");
}

server.registerTool(
  "get_job",
  {
    title: "Get a FINN job ad",
    description:
      "Fetch the full advert for one FINN job listing: the complete job " +
      "description, application deadline, employer, required skills and the " +
      "apply link. Takes the ad id from search_jobs, or a finn.no ad URL.",
    inputSchema: {
      ad: z
        .string()
        .describe("FINN ad id (e.g. 474777851) or a full https://www.finn.no/job/ad/... URL."),
    },
  },
  async ({ ad }) => guard(async () => renderAd(await getAd(parseAdId(ad)))),
);

function renderOptions(options: ResolvedOption[], filter: FilterName): string {
  if (!options.length) return `No options found for filter "${filter}".`;
  return options
    .map((o) => {
      const where = o.path.length ? ` — in ${o.path.join(" / ")}` : "";
      const hits = o.hits != null ? ` (${o.hits} ${o.hits === 1 ? "ad" : "ads"})` : "";
      return `- ${o.name}${hits}${where}`;
    })
    .join("\n");
}

server.registerTool(
  "list_filter_options",
  {
    title: "List FINN filter options",
    description:
      "Browse the filter values FINN Jobb currently offers, read live from " +
      "finn.no so they are never stale. Use it to find the exact spelling of " +
      "an area, job function or industry before calling search_jobs, or to " +
      "see how many ads sit under each option.",
    inputSchema: {
      filter: z
        .enum(FILTER_NAMES as unknown as [FilterName, ...FilterName[]])
        .describe(
          "Which filter to list. 'location' = areas, 'occupation' = job " +
            "functions, 'industry' = industries.",
        ),
      contains: z
        .string()
        .optional()
        .describe("Only show options whose name or parent contains this text (case-insensitive)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum options to return. Defaults to 200."),
    },
  },
  async ({ filter, contains, limit }) =>
    guard(async () => {
      let options = await optionsFor(filter);
      if (contains?.trim()) {
        const needle = contains.trim().toLowerCase();
        options = options.filter(
          (o) =>
            o.name.toLowerCase().includes(needle) ||
            o.path.some((p) => p.toLowerCase().includes(needle)),
        );
      }
      const capped = options.slice(0, limit ?? 200);
      const aliases = ALIASES[filter];
      const aliasNote = aliases
        ? `\n\nEnglish aliases accepted by search_jobs: ${Object.entries(aliases)
            .map(([k, v]) => `${k} = ${v}`)
            .join(", ")}`
        : "";
      const truncated =
        options.length > capped.length
          ? `\n\n(${options.length - capped.length} more — narrow with \`contains\`.)`
          : "";
      return `**${filter}** — ${options.length} options\n\n${renderOptions(capped, filter)}${truncated}${aliasNote}`;
    }),
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error("finn-mcp failed to start:", err);
  process.exit(1);
});
