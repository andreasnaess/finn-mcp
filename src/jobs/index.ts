#!/usr/bin/env node
/**
 * finn-jobs-mcp over stdio — the entry point for local clients (Claude Code,
 * Claude Desktop). The tools themselves live in `server.ts`.
 */

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { createServer } from "./server.js";

async function main(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error("finn-jobs-mcp failed to start:", err);
  process.exit(1);
});
