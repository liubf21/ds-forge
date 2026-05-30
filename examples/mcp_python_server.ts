#!/usr/bin/env npx tsx
/**
 * MCP server that executes Python code — reads JSON-RPC from stdin,
 * responds on stdout. Supports initialize, tools/list, tools/call.
 *
 * Exposes a single tool, `run_python`, which spawns a Python subprocess,
 * runs the given code, and returns its captured stdout/stderr.
 *
 * ⚠️  SECURITY: this runs ARBITRARY code with the current user's
 *     privileges (same as §3 "stdio = 你的 shell 权限" in docs/mcp.md).
 *     It does NOT sandbox. Only point an agent at this on a machine you
 *     are willing to let that agent control. For real use, run inside a
 *     container / VM / nsjail with no network and a scratch filesystem.
 *
 * Usage:
 *   npx tsx examples/mcp_python_server.ts
 *   PYTHON_BIN=./.venv/bin/python npx tsx examples/mcp_python_server.ts
 */

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const PYTHON_BIN = process.env.PYTHON_BIN ?? "python3";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024; // truncate runaway output before it floods the model

const tools = [
  {
    name: "run_python",
    description:
      "Execute Python 3 code and return its stdout/stderr. Use print() to surface results.",
    inputSchema: {
      type: "object" as const,
      properties: {
        code: { type: "string", description: "Python source to execute." },
        timeout_ms: {
          type: "number",
          description: `Kill the process after this many ms (default ${DEFAULT_TIMEOUT_MS}).`,
        },
      },
      required: ["code"],
    },
  },
];

function respond(id: number | string, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function error(id: number | string, code: number, message: string) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
  );
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
}

function runPython(code: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_BIN, ["-c", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const cap = (buf: string, chunk: Buffer) =>
      buf.length < MAX_OUTPUT_BYTES ? buf + chunk.toString() : buf;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.stdout.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
    proc.stderr.on("data", (c: Buffer) => (stderr = cap(stderr, c)));

    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: null, timedOut, spawnError: String(e) });
    });

    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}

/** Build the MCP tool-call result. Errors are returned as text (isError), not thrown. */
function formatResult(r: ExecResult, timeoutMs: number) {
  if (r.spawnError) {
    return {
      content: [{ type: "text", text: `Failed to start ${PYTHON_BIN}: ${r.spawnError}` }],
      isError: true,
    };
  }
  if (r.timedOut) {
    return {
      content: [
        { type: "text", text: `Execution timed out after ${timeoutMs}ms.\n${r.stdout}${r.stderr}` },
      ],
      isError: true,
    };
  }

  const parts: string[] = [];
  if (r.stdout) parts.push(r.stdout.replace(/\n$/, ""));
  if (r.stderr) parts.push(`--- stderr ---\n${r.stderr.replace(/\n$/, "")}`);
  const text = parts.join("\n") || "(no output)";

  return {
    content: [{ type: "text", text }],
    isError: r.exitCode !== 0,
  };
}

async function handleRequest(msg: any) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "python-server", version: "1.0.0" },
      });
      break;

    case "tools/list":
      respond(id, { tools });
      break;

    case "tools/call": {
      const { name, arguments: args } = params ?? {};
      if (name !== "run_python") {
        error(id, -32602, `Unknown tool: ${name}`);
        break;
      }
      const code = args?.code;
      if (typeof code !== "string") {
        error(id, -32602, "run_python requires a string `code` argument.");
        break;
      }
      const timeoutMs = Number(args?.timeout_ms) || DEFAULT_TIMEOUT_MS;
      const result = await runPython(code, timeoutMs);
      respond(id, formatResult(result, timeoutMs));
      break;
    }

    default:
      // Notifications (no id) are silently ignored.
      if (id != null) error(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore unparseable input
  }
  // Fire-and-forget: responses are matched by id, so out-of-order is fine.
  void handleRequest(msg);
});
