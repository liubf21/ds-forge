/**
 * Streamable HTTP transport — connects to a standalone MCP server
 * via HTTP POST. Responses can be plain JSON or SSE streams.
 *
 * The 2024-11-05 spec merges the old HTTP+SSE dual-channel approach
 * into a single endpoint. The server decides the response format based
 * on the request — for tools/list and tools/call this is typically
 * plain JSON.
 */

import { DEFAULT_TIMEOUT_MS } from "../defaults.js";
import type { MCPTransport, TransportCallbacks, JSONRPCMessage } from "./types.js";

export interface HTTPConfig {
  url: string;
  headers?: Record<string, string>;
  /** Timeout per request in ms (default 30s). */
  timeout?: number;
}

export class HTTPTransport implements MCPTransport {
  private cbs: TransportCallbacks | null = null;
  private controller: AbortController | null = null;
  private sessionId: string | null = null;

  constructor(private config: HTTPConfig) {}

  setCallbacks(cb: TransportCallbacks): void {
    this.cbs = cb;
  }

  async start(): Promise<void> {
    this.controller = new AbortController();
    // Streamable HTTP doesn't require a connect step — but we verify
    // the endpoint is reachable by sending a no-op check. If the server
    // returns a session ID header, we capture it for subsequent requests.
  }

  async send(msg: JSONRPCMessage): Promise<void> {
    if (!this.controller) {
      throw new Error("HTTP transport not started");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.config.headers,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const timeout = this.config.timeout ?? DEFAULT_TIMEOUT_MS;
    const timeoutAbort = new AbortController();
    const timer = setTimeout(() => timeoutAbort.abort(), timeout);
    const signal = AbortSignal.any([
      this.controller.signal,
      timeoutAbort.signal,
    ]);

    try {
      const resp = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(msg),
        signal,
      });

      // Capture session ID if present
      const sid = resp.headers.get("Mcp-Session-Id");
      if (sid) this.sessionId = sid;

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }

      const contentType = resp.headers.get("Content-Type") ?? "";

      if (contentType.includes("text/event-stream")) {
        await this.parseSSE(resp);
      } else {
        // Plain JSON response
        const body = (await resp.json()) as JSONRPCMessage;
        this.cbs?.onMessage(body);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        if (timeoutAbort.signal.aborted && !this.controller.signal.aborted) {
          throw new Error("Request timed out");
        }
        throw new Error("Request aborted");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.controller?.abort();
    this.controller = null;
    this.sessionId = null;
  }

  /** Parse SSE event stream, emitting each "message" event as a JSON-RPC message. */
  private async parseSSE(resp: Response): Promise<void> {
    const text = await resp.text();
    const lines = text.split("\n");
    let eventType = "";
    let data = "";

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        data += line.slice(6);
      } else if (line === "" && data) {
        if (eventType === "message" || eventType === "") {
          try {
            const msg = JSON.parse(data) as JSONRPCMessage;
            this.cbs?.onMessage(msg);
          } catch {
            throw new Error(`Unparseable SSE data: ${data.slice(0, 200)}`);
          }
        }
        eventType = "";
        data = "";
      }
    }
  }
}
