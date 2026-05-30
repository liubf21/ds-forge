# MCP HTTP failure path + client fixes (2026-05-31)

## Problems

1. **P1 — HTTP errors swallowed**: `HTTPTransport.send()` caught failures and only called `onError`, so `_request()` kept waiting until the 30s client timeout.
2. **P1 — Incomplete pending cleanup**: `send().catch(reject)` did not `pending.delete(id)` or `clearTimeout(timer)` on immediate send failure.
3. **P2 — Server→client requests ignored**: `_handleMessage()` only matched responses; server-initiated JSON-RPC requests were dropped, which can hang servers expecting a reply.

## Changes

### `transport-http.ts`
- `!resp.ok` → **throw** instead of `onError` + return.
- `catch` block → **rethrow** (AbortError mapped to `"Request timed out"`).
- Unparseable SSE payload → **throw** instead of `onError`.

Transport `send()` now rejects on failure; `onError` remains for stdio-style async background noise.

### `client.ts`
- `_request()`: on `send()` rejection, synchronously clear timer, delete pending entry, then `pending.reject()`.
- `_handleMessage()`: detect server requests (`method` + `id`, no `result`/`error`) and reply with JSON-RPC `-32601 Method not supported`.
- Added `_isServerRequest()` and `_respondUnsupported()` helpers.

### Tests (`examples/mcp_test.ts`)
- `test_http_failure_fast`: HTTP 500 must fail in <2s, not hang until timeout.
- `test_server_request`: mock transport verifies `-32601` response to server `ping`.

## Design note

Request/response matching stays in `MCPClient`; transports are dumb pipes. HTTP is synchronous per POST, but the same pending-map pattern applies — so transport failures must reject `send()` promptly.
