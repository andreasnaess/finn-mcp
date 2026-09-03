#!/usr/bin/env node
/**
 * Starts each server over stdio, completes the MCP handshake and prints what
 * the server reports about itself plus the tools it exposes. Replaces a plain
 * `start` script, which only ever hung waiting for JSON-RPC on stdin.
 *
 * Where a marketplace defines a check in DEEP_CHECKS, the tools are also
 * called for real, because a server that starts and lists its tools can still
 * return empty results after FINN changes its markup.
 *
 *   npm run smoke          # every marketplace
 *   npm run smoke jobs     # one marketplace
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

const servers = Object.entries(pkg.bin ?? {}).map(([binName, binPath]) => ({
  serverName: binName.replace(/-mcp$/, ""),
  marketplace: binName.replace(/-mcp$/, "").replace(/^finn-/, ""),
  entry: resolve(repoRoot, binPath),
}));

const wanted = process.argv.slice(2);
const selected = wanted.length
  ? servers.filter(
      (s) => wanted.includes(s.marketplace) || wanted.includes(s.serverName),
    )
  : servers;

/**
 * Runs one server as a child process and hands `body` a JSON-RPC caller,
 * shutting the child down afterwards however `body` ends.
 */
async function withServer(entry, body) {
  const child = spawn("node", [entry], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 1;
  let buffered = "";
  let stderr = "";

  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    // One JSON-RPC message per line over stdio.
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  const request = (method, params, timeoutMs = 30_000) =>
    new Promise((resolvePromise, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolvePromise(message.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  child.on("error", (error) => {
    for (const settle of pending.values()) settle({ error: { message: error.message } });
  });
  child.on("exit", (code) => {
    for (const settle of pending.values())
      settle({ error: { message: `exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}` } });
    pending.clear();
  });

  try {
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "1" },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
    /** Call a tool and return its rendered text. */
    const callTool = async (name, args) => {
      const result = await request("tools/call", { name, arguments: args });
      return (result.content ?? []).map((part) => part.text ?? "").join("\n");
    };
    return await body({ init, request, callTool });
  } finally {
    child.kill();
  }
}

/**
 * Per-marketplace checks that the tools return usable data, not just a tool
 * list. Keyed by server name; a marketplace without an entry is simply not
 * checked, so adding one still means adding a `bin` entry and nothing else.
 *
 * Each returns a line to print, or throws to fail the run.
 */
const DEEP_CHECKS = {
  "finn-jobs": async (callTool) => {
    // FINN serves ads from two different templates and changes its markup
    // without notice, so assert against freshly published ads rather than a
    // stored fixture: a parser that silently stops finding the advert body is
    // exactly the failure a fixture would go on hiding.
    const listing = await callTool("search_jobs", { limit: 5, sort: "published" });
    const ids = [...listing.matchAll(/id `(\d+)`/g)].map((m) => m[1]);
    if (ids.length === 0) throw new Error("search_jobs returned no ads");

    const broken = [];
    for (const id of ids) {
      const ad = await callTool("get_job", { ad: id });
      const advert = ad.split("## Advert")[1] ?? "";
      if (advert.trim().length < 200) broken.push(`${id} (no advert body)`);
      else if (!/^\*\*.+\*\*/m.test(ad)) broken.push(`${id} (no employer)`);
    }
    if (broken.length) throw new Error(`incomplete ads: ${broken.join(", ")}`);
    return `${ids.length}/${ids.length} recently published ads parsed with an advert body`;
  },
};

let failed = false;
for (const { serverName, entry } of selected) {
  if (!existsSync(entry)) {
    console.error(`✗ ${serverName}: not built — run \`npm install\``);
    failed = true;
    continue;
  }
  try {
    await withServer(entry, async ({ init, request, callTool }) => {
      const info = init.serverInfo ?? {};
      const names = ((await request("tools/list")).tools ?? []).map((t) => t.name);
      console.log(`✓ ${serverName}: ${info.name}@${info.version} — ${names.length} tools`);
      for (const name of names) console.log(`    ${name}`);

      const check = DEEP_CHECKS[serverName];
      if (check) console.log(`✓ ${serverName}: ${await check(callTool)}`);
    });
  } catch (error) {
    console.error(`✗ ${serverName}: ${error.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
