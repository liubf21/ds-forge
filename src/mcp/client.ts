/**
 * MCPClient — protocol layer that sits on top of a Transport.
 *
 * Responsibilities:
 *   1. Initialize the MCP session (handshake, negotiate capabilities)
 *   2. Discover tools via tools/list and convert to ds-forge Tool objects
 *   3. Route tools/call requests when the agent invokes a tool
 *   4. Match JSON-RPC responses to pending requests by id
 *
 * The client has no opinion about transport — stdio or HTTP, same API.
 */

import { DEFAULT_TIMEOUT_MS } from "../defaults.js";
import { tool } from "../tools.js";
import type { Tool, JsonSchema } from "../types.js";
import { VERSION } from "../version.js";
import type {
  MCPTransport,
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCNotification,
} from "./types.js";

// ── MCP protocol constants ────────────────────────────────────────

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_NAME = "ds-forge";
const CLIENT_VERSION = VERSION;

// ── Pending request tracker ───────────────────────────────────────

interface Pending {
  resolve(result: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class MCPClient {
  private transport!: MCPTransport;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private _tools: Tool[] = [];
  private _serverInfo: Record<string, unknown> = {};
  private connected = false;

  /** The ds-forge Tool objects discovered from this server. */
  get tools(): Tool[] {
    return this._tools;
  }

  /** Server info returned by initialize. */
  get serverInfo(): Record<string, unknown> {
    return this._serverInfo;
  }

  constructor(transport: MCPTransport) {
    this.transport = transport;
    this.transport.setCallbacks({
      onMessage: (msg) => this._handleMessage(msg),
      onError: (err) => this._handleError(err),
      onClose: () => this._handleClose(),
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────

  async connect(): Promise<void> {
    await this.transport.start();

    // Step 1: initialize
    const initResult = await this._request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });

    this._serverInfo = (initResult as { serverInfo?: Record<string, unknown> })
      .serverInfo ?? {};

    // Step 2: send initialized notification (no response expected)
    await this._notify("notifications/initialized", {});

    // Step 3: discover tools
    const toolList = (await this._request("tools/list", {})) as {
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema: {
          type: "object";
          properties?: Record<string, unknown>;
          required?: string[];
        };
      }>;
    };

    this._tools = (toolList.tools ?? []).map((t) =>
      this._toForgeTool(t.name, t.description, t.inputSchema),
    );

    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
    // Reject all pending
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Connection closed"));
    }
    this.pending.clear();
    await this.transport.close();
  }

  // ── JSON-RPC primitives ────────────────────────────────────────

  private _request(
    method: string,
    params?: Record<string, unknown>,
    timeout = DEFAULT_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0" as const, id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request '${method}' timed out after ${timeout}ms`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(msg).catch((err) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private async _notify(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    const msg = { jsonrpc: "2.0" as const, method, params };
    await this.transport.send(msg);
  }

  private _handleMessage(msg: JSONRPCMessage): void {
    // Server-initiated request — respond so the server doesn't hang
    if (this._isServerRequest(msg)) {
      this._respondUnsupported(msg.id, msg.method);
      return;
    }

    // Response to a client-initiated request
    if (!("id" in msg) || !("result" in msg || "error" in msg)) {
      return;
    }

    const resp = msg as JSONRPCResponse;
    const pending = this.pending.get(resp.id);
    if (!pending) return; // stale or already timed out

    clearTimeout(pending.timer);
    this.pending.delete(resp.id);

    if (resp.error) {
      pending.reject(
        new Error(`JSON-RPC error ${resp.error.code}: ${resp.error.message}`),
      );
    } else {
      pending.resolve(resp.result);
    }
  }

  private _isServerRequest(msg: JSONRPCMessage): msg is JSONRPCRequest {
    return (
      "method" in msg &&
      "id" in msg &&
      msg.id != null &&
      !("result" in msg) &&
      !("error" in msg)
    );
  }

  private _respondUnsupported(id: number | string, method: string): void {
    const msg: JSONRPCResponse = {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not supported by client: ${method}`,
      },
    };
    this.transport.send(msg).catch((err) => {
      process.stderr.write(
        `[ds-forge MCP] Failed to send response for '${method}': ${err.message}\n`,
      );
    });
  }

  private _handleError(err: Error): void {
    // Transport-level errors — route to stderr since they're async
    // and there's no request to reject. Server process stderr, etc.
    process.stderr.write(`[ds-forge MCP] ${err.message}\n`);
  }

  private _handleClose(): void {
    this.connected = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Transport closed"));
    }
    this.pending.clear();
  }

  // ── MCP → ds-forge tool conversion ─────────────────────────────

  private _toForgeTool(
    name: string,
    description: string | undefined,
    inputSchema: {
      type: "object";
      properties?: Record<string, unknown>;
      required?: string[];
    },
  ): Tool {
    return tool({
      name,
      description: description ?? `MCP tool: ${name}`,
      parameters: {
        type: "object",
        properties: inputSchema.properties as Record<string, JsonSchema> | undefined,
        required: inputSchema.required,
      },
      execute: async (args: Record<string, unknown>) => {
        if (!this.connected) {
          return "Error: MCP client not connected";
        }
        try {
          const result = (await this._request("tools/call", {
            name,
            arguments: args,
          })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };

          // Convert MCP content array to string
          if (!result.content || result.content.length === 0) {
            return result.isError ? "Error: (empty)" : "(empty result)";
          }

          const texts = result.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text!);

          const output = texts.join("");

          return result.isError ? `Error: ${output}` : output;
        } catch (e) {
          return `Error calling MCP tool '${name}': ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    });
  }
}
