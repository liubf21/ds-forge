import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { Context, messageFromDict } from "./context.js";
import { Session } from "./session.js";
import { ToolRegistry } from "./tools.js";
import type {
  ForgeConfig,
  ForgeLoadConfig,
  ForgeDebugConfig,
  MessageDict,
  Tool,
  ToolCall,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_MAX_TURNS = 10;

export class Forge {
  readonly model: string;
  readonly client: OpenAI;
  readonly tools: ToolRegistry;
  context: Context;
  private _maxTokens: number;

  constructor(config: ForgeConfig = {}) {
    const apiKey =
      config.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "API key required. Set DEEPSEEK_API_KEY env var or pass apiKey in config.",
      );
    }

    this.model = config.model ?? DEFAULT_MODEL;
    this._maxTokens = config.maxTokens ?? 128_000;

    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    });

    this.tools = new ToolRegistry();
    for (const t of config.tools ?? []) {
      this.tools.register(t);
    }

    this.context = new Context();
    this.context.maxTokens = this._maxTokens;
    if (config.system) {
      this.context.addSystem(config.system);
    }
  }

  // ── single turn ──────────────────────────────────────────

  async chat(message: string, extra?: Record<string, unknown>): Promise<string> {
    this.context.addUser(message);
    return this._send(extra);
  }

  private async _send(extra?: Record<string, unknown>): Promise<string> {
    this.context.truncate();

    const toolSpecs = this.tools.toOpenAISpecs();
    const tools = toolSpecs.length > 0 ? toolSpecs : undefined;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: this.context.toList() as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools,
      ...extra,
    });

    const msg = response.choices[0]!.message;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const toolCalls = msg.tool_calls.map(
        (tc): ToolCall => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }),
      );
      this.context.addAssistant(msg.content, toolCalls);
      return JSON.stringify(toolCalls, null, 2);
    }

    this.context.addAssistant(msg.content);
    return msg.content || "";
  }

  // ── agent loop ───────────────────────────────────────────

  async run(
    message?: string,
    maxTurns: number = DEFAULT_MAX_TURNS,
    extra?: Record<string, unknown>,
  ): Promise<string> {
    if (message) {
      this.context.addUser(message);
    }

    for (let turn = 0; turn < maxTurns; turn++) {
      this.context.truncate();

      const toolSpecs = this.tools.toOpenAISpecs();
      const tools = toolSpecs.length > 0 ? toolSpecs : undefined;

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: this.context.toList() as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools,
        ...extra,
      });

      const msg = response.choices[0]!.message;

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const toolCalls: ToolCall[] = msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
        this.context.addAssistant(msg.content, toolCalls);

        for (const tc of msg.tool_calls) {
          const name = tc.function.name;
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            this.context.addToolResult(
              tc.id,
              `Error parsing tool arguments: ${tc.function.arguments}`,
              name,
            );
            continue;
          }

          const result = await this.tools.execute(name, args);
          this.context.addToolResult(tc.id, result, name);
        }

        continue;
      }

      // No tool calls — model is done
      this.context.addAssistant(msg.content);
      return msg.content || "";
    }

    return "[Max turns reached]";
  }

  async resume(
    message?: string,
    maxTurns: number = DEFAULT_MAX_TURNS,
    extra?: Record<string, unknown>,
  ): Promise<string> {
    return this.run(message, maxTurns, extra);
  }

  // ── persistence ──────────────────────────────────────────

  save(path: string): void {
    Session.fromForge(this).save(path);
  }

  static load(path: string, config: ForgeLoadConfig = {}): Forge {
    const session = Session.load(path);

    const forge = new Forge({
      apiKey: config.apiKey,
      model: session.model,
      system: session.system ?? undefined,
      tools: config.tools ?? [],
      baseURL: config.baseURL,
    });
    forge.context = Context.fromDicts(session.messages);

    if (config.tools && config.tools.length > 0) {
      session.validateTools(forge.tools);
    }

    return forge;
  }

  // ── debug ────────────────────────────────────────────────

  static async debug(
    path: string,
    config: ForgeDebugConfig = {},
  ): Promise<{
    role: string;
    content: string | null;
    tool_calls: ToolCall[] | null;
  }> {
    const apiKey =
      config.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error("API key required.");
    }

    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);

    let messages: MessageDict[];
    if (Array.isArray(data)) {
      messages = data;
    } else if (data && Array.isArray(data.messages)) {
      messages = data.messages;
    } else {
      throw new Error(
        `Expected a message list or session dict, got ${typeof data}`,
      );
    }

    const client = new OpenAI({
      apiKey,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    });

    let toolSpecs = undefined;
    if (config.tools && config.tools.length > 0) {
      const reg = new ToolRegistry();
      for (const t of config.tools) reg.register(t);
      toolSpecs = reg.toOpenAISpecs();
    }

    const response = await client.chat.completions.create({
      model: config.model ?? DEFAULT_MODEL,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: toolSpecs,
    });

    const rawMsg = response.choices[0]!.message;
    return {
      role: rawMsg.role,
      content: rawMsg.content,
      tool_calls: rawMsg.tool_calls
        ? rawMsg.tool_calls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          }))
        : null,
    };
  }
}
