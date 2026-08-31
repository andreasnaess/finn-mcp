#!/usr/bin/env node
/**
 * Starts each server over stdio, completes the MCP handshake and prints what
 * the server reports about itself plus the tools it exposes. Replaces a plain
 * `start` script, which only ever hung waiting for JSON-RPC on stdin.
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

/** Drive one server through initialize + tools/list, resolving to its replies. */
const handshake = (entry) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("node", [entry], { stdio: ["pipe", "pipe", "pipe"] });
    const replies = [];
    let buffered = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out after 10s without completing the handshake"));
    }, 10_000);

    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      // One JSON-RPC message per line over stdio.
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        replies.push(JSON.parse(line));
        if (replies.length === 1) {
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
          );
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
          );
        } else {
          clearTimeout(timer);
          child.kill();
          resolvePromise({ init: replies[0], tools: replies[1] });
        }
      }
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (replies.length < 2) {
        reject(new Error(`exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "smoke", version: "1" },
        },
      }) + "\n",
    );
  });

let failed = false;
for (const { serverName, entry } of selected) {
  if (!existsSync(entry)) {
    console.error(`✗ ${serverName}: not built — run \`npm install\``);
    failed = true;
    continue;
  }
  try {
    const { init, tools } = await handshake(entry);
    const info = init.result?.serverInfo ?? {};
    const names = (tools.result?.tools ?? []).map((t) => t.name);
    console.log(`✓ ${serverName}: ${info.name}@${info.version} — ${names.length} tools`);
    for (const name of names) console.log(`    ${name}`);
  } catch (error) {
    console.error(`✗ ${serverName}: ${error.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
