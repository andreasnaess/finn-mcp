# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

pnpm, not npm (`packageManager` is pinned; `prepare` builds on install).

```sh
pnpm install            # installs and builds
pnpm run build          # tsc
pnpm run watch          # tsc --watch
pnpm run smoke          # the test suite — see below
pnpm run smoke jobs     # one marketplace only
pnpm run register       # register each server with Claude Code (-- --print for JSON)
pnpm run worker:dev     # the jobs server over HTTP, locally
pnpm run worker:deploy  # deploy that Worker to Cloudflare
```

`smoke` is the only test. There is no unit-test framework, and adding fixtures
would defeat the point: it starts each server, handshakes, and — via
`DEEP_CHECKS` in `scripts/smoke.mjs` — calls the tools for real against
freshly published FINN ads. A parser that silently stops finding the advert
body is exactly the failure a stored fixture would hide. It needs network.

## Architecture

One MCP server per FINN **marketplace** (the word for these is "marketplace",
never "vertical"). `src/core/` is marketplace-agnostic; `src/<marketplace>/`
is one server. Not a monorepo — one build, one `package.json`.

A marketplace is a sibling of `src/jobs/` with its own `config.ts` (a
`Marketplace` endpoint triple plus its alias table) and `server.ts`, plus a
`bin` entry. Nothing marketplace-specific belongs in `core/`.

**Two entry points, one definition.** `jobs/server.ts` exports
`createServer()`, which registers all three tools; `jobs/index.ts` serves it
over stdio and `jobs/worker.ts` over HTTP on Cloudflare Workers. Tool changes
go in `server.ts` and reach both — don't register a tool in an entry point.

**Filter codes are resolved at runtime, never hard-coded.** Every FINN filter
value is an opaque code (`occupation=1.23.2047`). Every search response carries
the complete `filters` tree, so `core/taxonomy.ts` reads codes from it and
resolves user-supplied names against it, cached an hour. This is what survives
FINN reorganising its taxonomy, as the 2024 county renumbering did. Do not bake
a code into the source, and do not copy filter listings into docs.

## Cloudflare Workers constraints

`src/` is bundled for workerd, so it must stay runtime-neutral:

- No `node:` builtins and nothing that needs `eval` (the MCP SDK's `workerd`
  export condition swaps in a Workers-safe JSON Schema validator; `tsconfig`
  needs only `["node"]` types). `scripts/` is Node-only and unconstrained.
- Module-scope state is per-isolate and per-process, not global. Caching a
  plain value is fine; **never share an in-flight promise across requests** —
  awaiting one created by another request throws "Cannot perform I/O on behalf
  of a different request". `core/taxonomy.ts` documents this at the cache.

The deployed Worker is authless (public read-only data) and rate limits itself
via a binding in `wrangler.toml`, because WAF rules need a zone and
`workers.dev` is not one. That binding is permissive and eventually consistent,
so an initial burst can slip through before it enforces.

## Caveats

FINN's endpoints are undocumented and unversioned. The runtime taxonomy absorbs
value changes; an endpoint or markup change needs a fix here, found by running
`smoke` against live FINN. Requests go one at a time under an identifying
`User-Agent`, at browsing volumes.
