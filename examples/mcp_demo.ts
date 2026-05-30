#!/usr/bin/env npx tsx
/**
 * MCP playground — connect to one MCP server over stdio, fire some
 * direct tool calls, then (optionally) run the agent loop.
 *
 * To test a different server or tool, just edit the CONFIG block below
 * and comment out what you don't need. No API key is required for the
 * direct tool calls (sections 1–2); only the agent loop (section 3)
 * needs DEEPSEEK_API_KEY.
 *
 * Usage:
 *   npx tsx examples/mcp_demo.ts                  # tools only
 *   DEEPSEEK_API_KEY=sk-... npx tsx examples/mcp_demo.ts   # + agent loop
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Forge, MCPClient, StdioTransport } from "../src/index.js";
// import { HTTPTransport } from "../src/index.js"; // for HTTP servers

const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════
// CONFIG — comment out what you don't need
// ═══════════════════════════════════════════════════════════════

// 1. Pick ONE server (uncomment exactly one).
// const SERVER = "mcp_echo_server.ts";
const SERVER = "mcp_python_server.ts";

// 2. Direct tool calls to run (comment out the lines you don't want).
//    Calls for tools the server doesn't expose are skipped with a warning.
const CALLS: Array<{ tool: string; args: Record<string, unknown> }> = [
  // echo server
  // { tool: "add", args: { a: 1, b: 2 } },
  // { tool: "echo", args: { text: "hello" } },
  // { tool: "failing_tool", args: {} },
  // python server
  { tool: "run_python", args: { code: "print(sum(range(100)))" } },
  { tool: "run_python", args: { code: "import sys; sys.exit(1)" } },
];

// 3. Agent-loop task (set to "" to skip the model call).
// const TASK = "Add 40 and 2, then echo the result.";
const TASK = "用 Python 算 1 到 100 里有几个质数，只回答数字";

// ═══════════════════════════════════════════════════════════════

const SERVER_PATH = resolve(__dirname, SERVER);

async function main() {
  // ── 1. Connect ──────────────────────────────────────────────
  console.log("=".repeat(60));
  console.log(`1. MCP CONNECT (stdio) — ${SERVER}`);
  console.log("=".repeat(60));

  const transport = new StdioTransport({
    command: "npx",
    args: ["tsx", SERVER_PATH],
  });
  const mcp = new MCPClient(transport);
  await mcp.connect();

  console.log(`Server: ${JSON.stringify(mcp.serverInfo)}`);
  console.log(`Tools discovered: ${mcp.tools.length}`);
  for (const t of mcp.tools) console.log(`  - ${t.name}: ${t.description}`);

  // ── 2. Direct tool calls (no model) ─────────────────────────
  console.log();
  console.log("=".repeat(60));
  console.log("2. DIRECT TOOL CALLS (no model)");
  console.log("=".repeat(60));

  for (const { tool, args } of CALLS) {
    const t = mcp.tools.find((x) => x.name === tool);
    if (!t) {
      console.log(`  (skip) ${tool} — not exposed by this server`);
      continue;
    }
    const out = await t.execute(args);
    console.log(`  ${tool}(${JSON.stringify(args)}) = ${out}`);
  }

  // ── 3. Agent loop (model + MCP tools) ───────────────────────
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (TASK && apiKey) {
    console.log();
    console.log("=".repeat(60));
    console.log("3. AGENT LOOP (model + MCP tools)");
    console.log("=".repeat(60));

    const forge = new Forge({
      apiKey,
      system: "You are a helpful assistant. Use tools when needed. Keep responses short.",
      tools: mcp.tools,
    });

    const result = await forge.run(TASK);
    console.log(`\nTask:  ${TASK}`);
    console.log(`Final: ${result}`);

    console.log("\n--- message history ---");
    for (const m of forge.context.messages) {
      let body: string;
      if (m.tool_calls?.length) {
        // assistant turn that requests tool calls — show name + args
        body = m.tool_calls
          .map((tc) => `→ ${tc.function.name}(${tc.function.arguments})`)
          .join("  ");
      } else if (typeof m.content === "string") {
        body = m.content.slice(0, 100) + (m.content.length > 100 ? "..." : "");
      } else {
        body = JSON.stringify(m.content);
      }
      // tool-result messages carry the tool name; surface it in the tag
      const tag = m.name ? `${m.role}:${m.name}` : m.role;
      console.log(`[${tag}] ${body}`);
    }
  } else {
    console.log();
    console.log(
      TASK
        ? "3. AGENT LOOP skipped — set DEEPSEEK_API_KEY to run it."
        : "3. AGENT LOOP skipped — TASK is empty.",
    );
  }

  await mcp.close();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error("MCP demo failed:", e);
  process.exit(1);
});
