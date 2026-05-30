/**
 * MCP-layer type definitions.
 *
 * Layers:
 *   JSON-RPC 2.0           — wire format, request/response matching by id
 *   MCP protocol messages   — initialize, tools/list, tools/call, etc.
 *   Transport               — stdio or Streamable HTTP, just a message pipe
 *
 * Transport is the seam: JSON-RPC doesn't know about pipes or HTTP,
 * MCPClient doesn't know how messages travel. Swapping transports is
 * one line at the call site.
 */

// ── JSON-RPC 2.0 ──────────────────────────────────────────────────

export interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JSONRPCError;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JSONRPCNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export type JSONRPCMessage =
  | JSONRPCRequest
  | JSONRPCResponse
  | JSONRPCNotification;

// ── MCP protocol ──────────────────────────────────────────────────

export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPToolCallResult {
  content: MCPContent[];
  isError?: boolean;
}

export type MCPContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: MCPResourceContent };

export interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

// ── Transport (the seam) ──────────────────────────────────────────
//
// A transport is a bidirectional message pipe. It delivers JSON-RPC
// messages to the server and fires onMessage for every message back.
// It has no knowledge of protocol semantics — that lives in MCPClient.

export interface TransportCallbacks {
  onMessage(msg: JSONRPCMessage): void;
  onError(err: Error): void;
  onClose(): void;
}

export interface MCPTransport {
  /** Open the connection. Must resolve before send() is called. */
  start(): Promise<void>;
  /** Send a JSON-RPC message to the server. */
  send(msg: JSONRPCMessage): Promise<void>;
  /** Clean shutdown. */
  close(): Promise<void>;
  /** Register callbacks. Called once before start(). */
  setCallbacks(cb: TransportCallbacks): void;
}
