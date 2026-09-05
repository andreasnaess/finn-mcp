/**
 * finn-jobs-mcp over HTTP — the entry point for Cloudflare Workers.
 *
 * The server is authless: every tool reads public, read-only finn.no data, so
 * there is no credential to check and nothing user-specific to protect. What
 * it does need is a cap on abuse, so a rate limiter sits in front of the MCP
 * handler — see wrangler.toml for the rate. See README for the connector
 * setup.
 *
 * `createServer` is called per request rather than once at module scope: a
 * Worker isolate serves many requests concurrently, and an MCP server instance
 * is bound to the exchange it is serving.
 */

import { createMcpHandler } from "@modelcontextprotocol/server";

import { createServer } from "./server.js";

// `mayFetchToDescribe: false`: never spend a finn.no request just to fill in a
// tool description. See `ServerOptions` in server.ts — on workers.dev there is
// no edge cache, so that request is paid again by every cold isolate, and
// finn.no answers Cloudflare's range with 403s when it sees that volume.
const handler = createMcpHandler(() => createServer({ mayFetchToDescribe: false }));

interface Env {
  RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) return new Response("Too many requests", { status: 429 });

    return handler.fetch(request);
  },
};
