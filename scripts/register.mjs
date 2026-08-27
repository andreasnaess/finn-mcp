#!/usr/bin/env node
/**
 * Registers this repo's MCP servers with Claude Code.
 *
 * The `bin` map in package.json is the single source of truth: each entry is
 * one vertical's server, and its name minus the `-mcp` suffix is the name the
 * server is registered under (`finn-jobs-mcp` -> `finn-jobs`). Adding a
 * vertical therefore means adding a `bin` entry and nothing else.
 *
 *   npm run register              # every vertical
 *   npm run register jobs         # one vertical, by short name or server name
 *   npm run register -- --print   # emit mcpServers JSON for other MCP clients
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

/** One registerable server, derived from a `bin` entry. */
const servers = Object.entries(pkg.bin ?? {}).map(([binName, binPath]) => {
  const serverName = binName.replace(/-mcp$/, "");
  return {
    serverName,
    vertical: serverName.replace(/^finn-/, ""),
    entry: resolve(repoRoot, binPath),
  };
});

if (servers.length === 0) {
  console.error("No `bin` entries in package.json — nothing to register.");
  process.exit(1);
}

// npm passes script args through after `--`; accept short or full names.
const args = process.argv.slice(2);
const printOnly = args.includes("--print");
const wanted = args.filter((a) => !a.startsWith("--"));
const selected = wanted.length
  ? servers.filter((s) => wanted.includes(s.vertical) || wanted.includes(s.serverName))
  : servers;

if (selected.length === 0) {
  console.error(
    `Unknown vertical: ${wanted.join(", ")}\n` +
      `Known: ${servers.map((s) => s.vertical).join(", ")}`,
  );
  process.exit(1);
}

// A missing build is the common failure; say so rather than registering a path
// that does not exist yet.
const unbuilt = selected.filter((s) => !existsSync(s.entry));
if (unbuilt.length > 0) {
  console.error(
    `Not built: ${unbuilt.map((s) => s.serverName).join(", ")}\n` +
      `Run \`npm install\` (which builds via the prepare script) first.`,
  );
  process.exit(1);
}

// Every MCP client takes the same command/args pair; print it for the ones
// that are configured by hand rather than by the `claude` CLI.
if (printOnly) {
  const mcpServers = Object.fromEntries(
    selected.map((s) => [s.serverName, { command: "node", args: [s.entry] }]),
  );
  console.log(JSON.stringify({ mcpServers }, null, 2));
  process.exit(0);
}

if (spawnSync("claude", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.error(
    "The `claude` CLI was not found on PATH.\n" +
      "Run `npm run register -- --print` for config you can paste into another client.",
  );
  process.exit(1);
}

for (const { serverName, entry } of selected) {
  // Re-registering is how you point Claude Code at a clone that has moved, so
  // drop any existing registration first. Absent is not an error.
  spawnSync("claude", ["mcp", "remove", serverName, "-s", "user"], { stdio: "ignore" });

  // `-s user` makes the server available in every project; a user-scoped server
  // is launched from an arbitrary cwd, so the entry path must be absolute.
  const add = spawnSync(
    "claude",
    ["mcp", "add", serverName, "-s", "user", "--", "node", entry],
    { stdio: "inherit" },
  );
  if (add.status !== 0) {
    console.error(`Failed to register ${serverName}.`);
    process.exit(add.status ?? 1);
  }
  console.log(`registered ${serverName} -> ${entry}`);
}
