/**
 * finn-jobs-mcp over HTTP — the entry point for Cloudflare Workers.
 *
 * The server is authless: every tool reads public, read-only finn.no data, so
 * there is no credential to check and nothing user-specific to protect. Abuse
 * is capped by a Cloudflare rate-limiting rule in front of the Worker, not
 * here. See README for the connector setup.
 *
 * `createServer` is called per request rather than once at module scope: a
 * Worker isolate serves many requests concurrently, and an MCP server instance
 * is bound to the exchange it is serving.
 */

import { createMcpHandler } from "@modelcontextprotocol/server";

import { createServer } from "./server.js";

const handler = createMcpHandler(() => createServer());

export default {
  fetch(request: Request): Promise<Response> {
    return handler.fetch(request);
  },
};
