#!/usr/bin/env npx tsx
/**
 * Minimal MCP server — reads JSON-RPC messages from stdin,
 * responds on stdout. Supports initialize, tools/list, tools/call.
 *
 * This is a teaching tool: run it standalone and inspect the wire format,
 * or use it as a target for MCPClient demos.
 *
 * Usage:
 *   npx tsx examples/mcp_echo_server.ts
 *
 * Then type JSON-RPC messages into stdin (one line each).
 */

import { createInterface } from "node:readline";

// Tool definitions that this server exposes
const tools = [
  {
    name: "add",
    description: "Add two numbers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        a: { type: "number", description: "First number." },
        b: { type: "number", description: "Second number." },
      },
      required: ["a", "b"],
    },
  },
  {
    name: "echo",
    description: "Echo back the input text.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Text to echo." },
      },
      required: ["text"],
    },
  },
  {
    name: "failing_tool",
    description: "Always fails — for testing error handling.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

function respond(id: number | string, result: unknown) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n",
  );
}

function error(id: number | string, code: number, message: string) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
  );
}

function handleRequest(msg: any) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "echo-server", version: "1.0.0" },
      });
      break;

    case "tools/list":
      respond(id, { tools });
      break;

    case "tools/call": {
      const { name, arguments: args } = params ?? {};
      if (name === "add") {
        respond(id, {
          content: [{ type: "text", text: String(Number(args?.a) + Number(args?.b)) }],
        });
      } else if (name === "echo") {
        respond(id, {
          content: [{ type: "text", text: `Echo: ${args?.text}` }],
        });
      } else if (name === "failing_tool") {
        respond(id, {
          content: [{ type: "text", text: "This tool always fails." }],
          isError: true,
        });
      } else {
        error(id, -32601, `Unknown tool: ${name}`);
      }
      break;
    }

    default:
      // Ignore notifications (no id)
      if (id != null) {
        error(id, -32601, `Method not found: ${method}`);
      }
  }
}

// Read newline-delimited JSON from stdin
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    handleRequest(JSON.parse(line));
  } catch {
    // Ignore unparseable input
  }
});
