export { Forge } from "./forge.js";
export { tool, ToolRegistry } from "./tools.js";
export { Context, messageToDict, messageFromDict, defaultTokenCounter } from "./context.js";
export type { MessageObj, MessageDict } from "./context.js";
export { Session } from "./session.js";
export type { SessionData } from "./session.js";
export { bashTool } from "./bash.js";
export type { BashOptions } from "./bash.js";
export { ForgeError } from "./types.js";
export type {
  Tool,
  ToolDef,
  ToolCall,
  JsonSchema,
  ForgeConfig,
  ForgeLoadConfig,
  ForgeDebugConfig,
  OpenAICompatibleToolSpec,
  StreamEvent,
} from "./types.js";

// MCP
export { MCPClient, StdioTransport, HTTPTransport } from "./mcp/index.js";
export type {
  StdioConfig,
  HTTPConfig,
  MCPTransport,
  TransportCallbacks,
  MCPToolDef,
  MCPToolCallResult,
  MCPContent,
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCNotification,
  JSONRPCError,
} from "./mcp/index.js";
