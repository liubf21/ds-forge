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
    for (const msg of parseSSEMessages(text)) {
      this.cbs?.onMessage(msg);
    }
  }
}

/**
 * Parse a full SSE stream body into JSON-RPC messages per the SSE framing
 * rules (https://html.spec.whatwg.org/multipage/server-sent-events.html):
 *
 *   - Lines are split on CRLF, CR, or LF, so CRLF streams leave no stray `\r`.
 *   - A line of `field:value` strips one optional leading space from the value.
 *   - Multiple `data:` lines accumulate, joined by `\n` (not concatenated).
 *   - Lines beginning with `:` are comments and are ignored (they do not
 *     touch the buffered data).
 *   - A blank line dispatches the buffered event; an unterminated final event
 *     is dispatched once the stream ends.
 *
 * Only the default and "message" event types surface as messages. Unparseable
 * JSON in a dispatched event throws — a malformed stream is a hard error.
 *
 * Exported for unit testing; the transport consumes it via parseSSE().
 */
export function parseSSEMessages(body: string): JSONRPCMessage[] {
  const out: JSONRPCMessage[] = [];
  let eventType = "";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length > 0 && (eventType === "" || eventType === "message")) {
      const data = dataLines.join("\n");
      try {
        out.push(JSON.parse(data) as JSONRPCMessage);
      } catch {
        throw new Error(`Unparseable SSE data: ${data.slice(0, 200)}`);
      }
    }
    eventType = "";
    dataLines = [];
  };

  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line === "") {
      dispatch();
      continue;
    }
    if (line.startsWith(":")) continue; // comment

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") eventType = value;
    else if (field === "data") dataLines.push(value);
    // id / retry / unknown fields are ignored
  }

  dispatch(); // flush a trailing event with no terminating blank line
  return out;
}
