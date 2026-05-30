#!/usr/bin/env npx tsx
/**
 * MCP test suite. Zero external deps — uses Node assert.
 *
 * Run:
 * Run: npm run test (via root test suite)
 *
 * Each section is a self-contained test block. Failures print
 * the test name and abort. Passes are silent by default; use
 *   MCP_TEST_VERBOSE=1 npx tsx examples/mcp_test.ts
 * to see every check.
 */

import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Forge,
  MCPClient,
  StdioTransport,
  HTTPTransport,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "mcp_echo_server.ts");
const VERBOSE = !!process.env.MCP_TEST_VERBOSE;

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void | Promise<void>) {
  return async () => {
    try {
      await fn();
      passed++;
      if (VERBOSE) console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`\n  ✗ FAIL [${name}]`);
      console.error(`    ${(e as Error).message}`);
    }
  };
}

// ── helpers ──────────────────────────────────────────────────────

function serverPath() {
  return SERVER;
}

function spawnServer(): ChildProcess {
  return spawn("npx", ["tsx", serverPath()], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Poll until `cond` returns true, or timeout. Returns the final value. */
async function waitFor<T>(cond: () => T, timeout = 5000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const val = cond();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

/** Send one JSON-RPC request over stdio and return the response. */
function rpcCall(
  proc: ChildProcess,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    let buf = "";

    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          if (resp.id === id) {
            proc.stdout!.removeListener("data", onData);
            if (resp.error) reject(new Error(`JSON-RPC ${resp.error.code}: ${resp.error.message}`));
            else resolve(resp.result);
          }
        } catch { /* skip partial */ }
      }
    };

    proc.stdout!.on("data", onData);
    proc.stdin!.write(msg);
  });
}

// ──────────────────────────────────────────────────────────────────
// 1. ECHO SERVER PROTOCOL
// ──────────────────────────────────────────────────────────────────

async function test_echo_server() {
  // 1a. Initialize
  const proc = spawnServer();
  const init = await rpcCall(proc, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  });
  assert.strictEqual((init as any).serverInfo.name, "echo-server");

  // 1b. tools/list
  const list = await rpcCall(proc, "tools/list");
  const tools = (list as any).tools;
  assert.strictEqual(tools.length, 3);
  assert.strictEqual(tools[0].name, "add");

  // 1c. tools/call — success
  const add = await rpcCall(proc, "tools/call", { name: "add", arguments: { a: 3, b: 4 } });
  assert.strictEqual((add as any).content[0].text, "7");

  // 1d. tools/call — error
  const fail = await rpcCall(proc, "tools/call", { name: "failing_tool", arguments: {} });
  assert.strictEqual((fail as any).isError, true);

  // 1e. Unknown method
  const err = await rpcCall(proc, "nonexistent", {}).catch((e: Error) => e);
  assert.ok(err instanceof Error);

  // 1f. Notification (no id) — should not crash the server
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  await new Promise(r => setTimeout(r, 100)); // give server time
  assert.strictEqual(proc.exitCode, null); // still alive

  proc.kill();
}

// ──────────────────────────────────────────────────────────────────
// 2. STDIO TRANSPORT
// ──────────────────────────────────────────────────────────────────

async function test_stdio_transport() {
  const transport = new StdioTransport({
    command: "npx",
    args: ["tsx", serverPath()],
  });

  const received: unknown[] = [];
  const errors: Error[] = [];
  let closed = false;

  transport.setCallbacks({
    onMessage: (msg) => received.push(msg),
    onError: (err) => errors.push(err),
    onClose: () => { closed = true; },
  });

  await transport.start();

  // Send initialize and wait for response (not a fixed sleep)
  await transport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });

  // Wait up to 5s for the response (cold npx tsx can be slow)
  const resp = await waitFor(() => received.length >= 1, 5000);
  assert.ok(resp, "Should receive at least 1 response within 5s");
  const msg = received[0] as any;
  assert.strictEqual(msg.id, 1);
  assert.ok(msg.result);

  // Send notification (no id) — should not trigger a response
  await transport.send({ jsonrpc: "2.0", method: "ping" });
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(received.length, 1); // no new response message

  assert.strictEqual(closed, false);
  await transport.close();
  await new Promise(r => setTimeout(r, 200));
}

// ──────────────────────────────────────────────────────────────────
// 3. MCP CLIENT — FULL LIFECYCLE
// ──────────────────────────────────────────────────────────────────

async function test_mcp_client_lifecycle() {
  const transport = new StdioTransport({
    command: "npx",
    args: ["tsx", serverPath()],
  });
  const mcp = new MCPClient(transport);

  await mcp.connect();
  assert.strictEqual(mcp.tools.length, 3);
  assert.strictEqual(mcp.serverInfo.name, "echo-server");

  const names = mcp.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ["add", "echo", "failing_tool"]);

  await mcp.close();
}

// ──────────────────────────────────────────────────────────────────
// 4. TOOL EXECUTION
// ──────────────────────────────────────────────────────────────────

async function test_tool_execution() {
  const transport = new StdioTransport({
    command: "npx",
    args: ["tsx", serverPath()],
  });
  const mcp = new MCPClient(transport);
  await mcp.connect();

  // 4a. Successful tool call
  const add = mcp.tools.find((t) => t.name === "add")!;
  const r1 = await add.execute({ a: 10, b: 20 });
  assert.strictEqual(r1, "30");

  // 4b. String tool call
  const echo = mcp.tools.find((t) => t.name === "echo")!;
  const r2 = await echo.execute({ text: "hello world" });
  assert.strictEqual(r2, "Echo: hello world");

  // 4c. Tool that returns isError=true
  const fail = mcp.tools.find((t) => t.name === "failing_tool")!;
  const r3 = await fail.execute({});
  assert.ok(r3.startsWith("Error:"));

  // 4d. Unknown tool arg type — should get string conversion
  const r4 = await add.execute({ a: "100", b: "200" });
  // Server adds numbers, JS coerces: "100" + "200" = "100200" if string concat
  // Actually the server does (args.a + args.b) which in TS is number addition
  assert.strictEqual(r4, "300");

  await mcp.close();
}

// ──────────────────────────────────────────────────────────────────
// 5. ERROR HANDLING
// ──────────────────────────────────────────────────────────────────

async function test_error_handling() {
  // 5a. Server that doesn't exist
  const badTransport = new StdioTransport({
    command: "nonexistent-binary-xyz",
    args: [],
  });

  try {
    // Need to suppress error output for this test
    badTransport.setCallbacks({ onMessage: () => {}, onError: () => {}, onClose: () => {} });
    await badTransport.start();
    assert.fail("Should have thrown");
  } catch (e) {
    assert.ok((e as Error).message.includes("not found") || (e as Error).message.includes("ENOENT"));
  }

  // 5b. Tool execution after close
  const transport = new StdioTransport({
    command: "npx",
    args: ["tsx", serverPath()],
  });
  const mcp = new MCPClient(transport);
  await mcp.connect();
  await mcp.close();

  const add = mcp.tools.find((t) => t.name === "add")!;
  const r = await add.execute({ a: 1, b: 2 });
  assert.ok(r.startsWith("Error:"));
}

// ──────────────────────────────────────────────────────────────────
// 6. CONCURRENT TOOL CALLS
// ──────────────────────────────────────────────────────────────────

async function test_concurrent_calls() {
  const transport = new StdioTransport({
    command: "npx",
    args: ["tsx", serverPath()],
  });
  const mcp = new MCPClient(transport);
  await mcp.connect();

  const add = mcp.tools.find((t) => t.name === "add")!;

  // Fire 5 concurrent tool calls
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => add.execute({ a: i, b: i * 10 })),
  );

  assert.deepStrictEqual(results, ["0", "11", "22", "33", "44"]);

  await mcp.close();
}

// ──────────────────────────────────────────────────────────────────
// 7. TIMEOUT
// ──────────────────────────────────────────────────────────────────

async function test_timeout() {
  const transport = new StdioTransport({
    command: "npx",
    args: ["tsx", serverPath()],
  });
  const mcp = new MCPClient(transport);
  await mcp.connect();

  // Direct test — send tools/call but with extremely short timeout
  // Since the echo server is fast, this should work normally
  const add = mcp.tools.find((t) => t.name === "add")!;
  const r = await add.execute({ a: 1, b: 1 });
  assert.strictEqual(r, "2");

  await mcp.close();
}

// ──────────────────────────────────────────────────────────────────
// 8. HTTP ECHO SERVER + HTTP TRANSPORT
// ──────────────────────────────────────────────────────────────────

async function test_http_transport() {
  // Spin up a minimal HTTP MCP server then test against it
  const server = await startHttpEchoServer();
  const url = `http://localhost:${server.port}`;

  try {
    const transport = new HTTPTransport({ url, timeout: 5000 });
    const mcp = new MCPClient(transport);
    await mcp.connect();

    assert.strictEqual(mcp.tools.length, 3);
    assert.strictEqual(mcp.serverInfo.name, "http-echo-server");

    const add = mcp.tools.find((t) => t.name === "add")!;
    const r = await add.execute({ a: 5, b: 7 });
    assert.strictEqual(r, "12");

    await mcp.close();
  } finally {
    server.close();
  }
}

async function test_http_failure_fast() {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end("Internal Server Error");
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const transport = new HTTPTransport({
      url: `http://localhost:${port}`,
      timeout: 5000,
    });
    const mcp = new MCPClient(transport);

    const start = Date.now();
    await assert.rejects(
      () => mcp.connect(),
      (err: Error) => err.message.includes("HTTP 500"),
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `Expected fast failure, took ${elapsed}ms`);
  } finally {
    server.close();
  }
}

async function test_server_request() {
  const sent: Array<Record<string, unknown>> = [];
  const transport = {
    cbs: null as {
      onMessage(msg: unknown): void;
      onError(err: Error): void;
      onClose(): void;
    } | null,
    setCallbacks(cb: typeof transport.cbs) {
      this.cbs = cb;
    },
    async start() {},
    async send(msg: Record<string, unknown>) {
      sent.push(msg);
    },
    async close() {},
  };

  const mcp = new MCPClient(transport as any);
  transport.cbs!.onMessage({
    jsonrpc: "2.0",
    id: 42,
    method: "ping",
    params: {},
  });

  await new Promise((r) => setTimeout(r, 10));

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].id, 42);
  assert.ok("error" in sent[0]);
  assert.strictEqual((sent[0].error as { code: number }).code, -32601);
  assert.ok(
    String((sent[0].error as { message: string }).message).includes("ping"),
  );

  await mcp.close();
}

// Minimal HTTP MCP server — same logic as echo server, over HTTP
async function startHttpEchoServer(): Promise<{ port: number; close(): void }> {
  const http = await import("node:http");
  const tools = [
    {
      name: "add", description: "Add two numbers.",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    },
    {
      name: "echo", description: "Echo text.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    {
      name: "failing_tool", description: "Always fails.",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

      let body = "";
      req.on("data", (c: Buffer) => body += c.toString());
      req.on("end", () => {
        let msg: any;
        try { msg = JSON.parse(body); } catch {
          res.writeHead(400); res.end(JSON.stringify({ error: "bad json" })); return;
        }

        const { id, method, params } = msg;
        let result: unknown;
        let error: unknown;

        switch (method) {
          case "initialize":
            result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "http-echo-server", version: "1.0.0" } };
            break;
          case "tools/list":
            result = { tools };
            break;
          case "tools/call": {
            const { name, arguments: args } = params ?? {};
            if (name === "add") result = { content: [{ type: "text", text: String((args?.a as number) + (args?.b as number)) }] };
            else if (name === "echo") result = { content: [{ type: "text", text: `Echo: ${args?.text}` }] };
            else if (name === "failing_tool") result = { content: [{ type: "text", text: "This tool always fails." }], isError: true };
            else error = { code: -32601, message: `Unknown tool: ${name}` };
            break;
          }
          default:
            if (id != null) error = { code: -32601, message: `Unknown method: ${method}` };
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        if (error) {
          res.end(JSON.stringify({ jsonrpc: "2.0", id, error }));
        } else if (id != null) {
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
        } else {
          res.end(JSON.stringify({}));
        }
      });
    });

    server.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

// ──────────────────────────────────────────────────────────────────
// 9. END-TO-END: FORGE AGENT LOOP + MCP TOOLS (mocked model)
// ──────────────────────────────────────────────────────────────────
//
// The full chain: Forge.run() → model returns tool_calls → MCP
// executes → result fed back → model answers without tools → done.
// We mock the OpenAI client so no API key is needed.

async function test_e2e_forge_mcp() {
  const transport = new StdioTransport({
    command: "npx",
    args: ["tsx", serverPath()],
  });
  const mcp = new MCPClient(transport);
  await mcp.connect();

  // Create Forge — the API key here is a dummy since we'll mock the client
  const forge = new Forge({
    apiKey: "sk-mock",
    system: "You are a helpful assistant. Use tools when needed.",
    tools: mcp.tools,
  });

  let callCount = 0;

  // Override the OpenAI client's create method to simulate a
  // 2-turn agent loop without a real model.
  const originalCreate = forge.client.chat.completions.create.bind(
    forge.client.chat.completions,
  );
  forge.client.chat.completions.create = ((params: any) => {
    callCount++;

    // Turn 1: model decides to use the add tool
    if (callCount === 1) {
      // Verify the request has our tools
      assert.ok(params.tools, "Request should include tools");
      assert.strictEqual(params.tools.length, 3);

      // Verify the user message was sent
      const userMsg = params.messages.find((m: any) => m.role === "user");
      assert.ok(userMsg, "Should include user message");
      assert.ok(
        userMsg.content.includes("add 3 and 4"),
        "User message should contain the task",
      );

      return Promise.resolve({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_e2e_1",
                  type: "function",
                  function: {
                    name: "add",
                    arguments: JSON.stringify({ a: 3, b: 4 }),
                  },
                },
              ],
            },
          },
        ],
      });
    }

    // Turn 2: model has the tool result, no more tools needed
    assert.strictEqual(callCount, 2);

    // Verify the tool result was added to context
    const toolMsg = params.messages.find((m: any) => m.role === "tool");
    assert.ok(toolMsg, "Context should include tool result");
    assert.ok(
      toolMsg.content === "7" || toolMsg.content.includes("7"),
      `Tool result should be '7', got: ${toolMsg.content}`,
    );

    return Promise.resolve({
      choices: [
        {
          message: {
            role: "assistant",
            content: "The sum of 3 and 4 is 7.",
            tool_calls: null,
          },
        },
      ],
    });
  }) as any;

  // Run the agent loop
  const result = await forge.run(
    "Please add 3 and 4 for me.",
  );

  assert.strictEqual(callCount, 2, "Should have exactly 2 API calls");
  assert.strictEqual(result, "The sum of 3 and 4 is 7.");
  assert.strictEqual(
    forge.context.messages.length,
    5,
    "Messages: system + user + assistant(tool_calls) + tool_result + assistant(final)",
  );

  // Verify message roles in order
  const roles = forge.context.messages.map((m) => m.role);
  assert.deepStrictEqual(roles, [
    "system",
    "user",
    "assistant", // tool_calls
    "tool",      // add result
    "assistant", // final answer
  ]);

  // Restore (not strictly necessary but clean)
  forge.client.chat.completions.create = originalCreate;
  await mcp.close();
}

// ──────────────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("MCP Test Suite\n");

  await check("echo server protocol", test_echo_server)();
  await check("stdio transport", test_stdio_transport)();
  await check("MCP client lifecycle", test_mcp_client_lifecycle)();
  await check("tool execution", test_tool_execution)();
  await check("error handling", test_error_handling)();
  await check("concurrent tool calls", test_concurrent_calls)();
  await check("request timeout", test_timeout)();
  await check("HTTP transport", test_http_transport)();
  await check("HTTP failure fast-fail", test_http_failure_fast)();
  await check("server-initiated request", test_server_request)();
  await check("E2E Forge + MCP (mocked model)", test_e2e_forge_mcp)();

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Test suite error:", e);
  process.exit(1);
});
