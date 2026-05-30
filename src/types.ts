/** Shared types for ds-forge. */

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  nullable?: boolean;
  additionalProperties?: JsonSchema | boolean;
  [key: string]: unknown; // for OpenAI index-signature compatibility
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface MessageDict {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface Tool extends ToolDef {
  execute: (args: Record<string, unknown>) => string | Promise<string>;
  toOpenAISpec: () => OpenAICompatibleToolSpec;
}

export interface OpenAICompatibleToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export interface ForgeConfig {
  apiKey?: string;
  model?: string;
  system?: string;
  tools?: Tool[];
  maxTokens?: number;
  baseURL?: string;
}

export interface ForgeLoadConfig {
  tools?: Tool[];
  apiKey?: string;
  /** Additional config passed to Forge constructor. */
  baseURL?: string;
}

export interface ForgeDebugConfig {
  apiKey?: string;
  model?: string;
  tools?: Tool[];
  baseURL?: string;
}

export class ForgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgeError";
  }
}
