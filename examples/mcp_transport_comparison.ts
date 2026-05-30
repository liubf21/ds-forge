#!/usr/bin/env npx tsx
/**
 * MCP transport evolution: old HTTP+SSE vs Streamable HTTP.
 *
 * This example starts two minimal MCP servers side-by-side:
 *   - Old-style (HTTP+SSE) on port 9401
 *   - Streamable HTTP on port 9402
 *
 * Then hits both with the same logical operations and prints
 * the raw wire format so you can compare.
 *
 * Run: npx tsx examples/mcp_transport_comparison.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// ── Shared fake MCP logic ────────────────────────────────────────

const tools = [
  { name: "get_weather", description: "Get weather for a city.", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
];

function handleMethod(method: string, params: any) {
  if (method === "initialize") return { protocolVersion: "2024-11-05", serverInfo: { name: "demo", version: "1.0" }, capabilities: { tools: {} } };
  if (method === "tools/list") return { tools };
  if (method === "tools/call") return { content: [{ type: "text", text: `Weather in ${(params?.arguments as any)?.city}: 22°C, sunny` }] };
  return null;
}

// ── 1. Old-style: HTTP + SSE (two endpoints) ─────────────────────

function oldStyleServer() {
  const sseClients = new Set<ServerResponse>();

  const s = createServer((req, res) => {
    // SSE endpoint — long-lived connection for server→client notifications
    if (req.method === "GET" && req.url === "/sse") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));

      // Send the endpoint URL so client knows where to POST
      res.write(`event: endpoint\ndata: http://localhost:${oldPort}/message\n\n`);
      return;
    }

    // Message endpoint — client sends JSON-RPC here
    if (req.method === "POST" && req.url === "/message") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body);
        const result = handleMethod(msg.method, msg.params);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));

        // Simulate server push: notify all SSE clients about tool list change
        for (const c of sseClients) {
          c.write(`event: tools/list_changed\ndata: {}\n\n`);
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return s;
}

// ── 2. New-style: Streamable HTTP (single endpoint) ──────────────

function streamableServer() {
  const s = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      const result = handleMethod(msg.method, msg.params);

      if (msg.method === "tools/call") {
        // Long-running tool → SSE stream to show progress
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Mcp-Session-Id": "sess_abc123",
        });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "Thinking..." }] } })}\n\n`);
        setTimeout(() => {
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
          res.end();
        }, 50);
      } else {
        // Simple query → plain JSON (no SSE overhead)
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "sess_abc123",
        });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      }
    });
  });

  return s;
}

// ── Run both servers and demonstrate ─────────────────────────────

let oldPort: number, newPort: number;

function listen(server: ReturnType<typeof createServer>, label: string): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      console.log(`${label} on port ${port}`);
      resolve(port);
    });
  });
}

function wire(name: string, request: string, response: string) {
  console.log(`${name}:`);
  console.log(`  Request:  ${request}`);
  console.log(`  Response: ${response}`);
  console.log();
}

function divider(title: string) {
  console.log(`${"=".repeat(60)}`);
  console.log(`${title}`);
  console.log(`${"=".repeat(60)}`);
}

async function demo() {
  const oldServer = oldStyleServer();
  const newServer = streamableServer();
  oldPort = await listen(oldServer, "Old HTTP+SSE");
  newPort = await listen(newServer, "Streamable HTTP");
  console.log();

  // ─── Demonstrate: initialize ───────────────────────────

  divider("initialize");

  // Old: must first connect to SSE, then POST to /message
  wire(
    "Old HTTP+SSE",
    `GET /sse (opens long-lived connection)\n` +
    `  then POST /message {\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\"}}`,
    `GET /sse → 200 text/event-stream (connection stays open)\n` +
    `  event: endpoint\n` +
    `  data: http://localhost:${oldPort}/message\n` +
    `  POST /message → 200 {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"demo\"},...}}`
  );

  // New: single POST, done
  wire(
    "Streamable HTTP",
    `POST /mcp {\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\"}}`,
    `200 application/json\n` +
    `  Mcp-Session-Id: sess_abc123\n` +
    `  {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"demo\"},...}}`
  );

  // ─── Demonstrate: tools/list ────────────────────────────

  divider("tools/list");

  wire(
    "Old HTTP+SSE",
    `POST /message {\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}`,
    `200 application/json\n` +
    `  {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"get_weather\",...}]}}`
  );

  wire(
    "Streamable HTTP",
    `POST /mcp {\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}`,
    `200 application/json\n` +
    `  Mcp-Session-Id: sess_abc123\n` +
    `  {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"get_weather\",...}]}}`
  );

  // ─── Demonstrate: server push ───────────────────────────

  divider("server push (tools/list_changed)");

  wire(
    "Old HTTP+SSE",
    `(no client request — server pushes via SSE connection autonomously)`,
    `event: tools/list_changed\n` +
    `  data: {}`
  );

  wire(
    "Streamable HTTP",
    `POST /mcp {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}`,
    `200 (empty — it's the server that would send this to the client,\n` +
    `  but in Streamable HTTP, server push is not needed for this use case.\n` +
    `  The client re-queries tools/list when it needs fresh state.)`
  );

  // ─── Demonstrate: tools/call with potential streaming ───

  divider("tools/call (long-running, with progress)");

  wire(
    "Old HTTP+SSE",
    `POST /message {\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"long_task\"}}`,
    `200 application/json\n` +
    `  {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}\n` +
    `  (progress updates come via SSE connection — but in practice they're\n` +
    `   on a different channel than the request, so correlation is manual)`
  );

  wire(
    "Streamable HTTP",
    `POST /mcp {\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"long_task\"}}`,
    `200 text/event-stream\n` +
    `  event: message\n` +
    `  data: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"Thinking...\"}]}}\n` +
    `  event: message\n` +
    `  data: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}`
  );

  // ─── Summary ────────────────────────────────────────────

  divider("summary");

  console.log("Key difference: number of connections.\n");
  console.log("Old HTTP+SSE:");
  console.log("  ┌─ GET /sse ──── SSE stream (stays open) ────────┐");
  console.log("  │  ↳ receives endpoint URL                        │");
  console.log("  │  ↳ receives notifications (tools/list_changed)   │");
  console.log("  └─────────────────────────────────────────────────┘");
  console.log("  ┌─ POST /message ── JSON-RPC request ──────────────┐");
  console.log("  │  ↳ returns JSON-RPC response                     │");
  console.log("  └─────────────────────────────────────────────────┘");
  console.log("  Two TCP connections. SSE connection breaks → session lost.\n");
  console.log("Streamable HTTP:");
  console.log("  ┌─ POST /mcp ── JSON-RPC ──────────────────────────┐");
  console.log("  │  ↳ returns JSON (simple) or SSE (streaming)      │");
  console.log("  │  ↳ Mcp-Session-Id header ties requests together  │");
  console.log("  └─────────────────────────────────────────────────┘");
  console.log("  One endpoint. Stateless per-request. Serverless-friendly.");

  oldServer.close();
  newServer.close();
}

demo().catch((e) => { console.error(e); process.exit(1); });
