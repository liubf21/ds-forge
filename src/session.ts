import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { messageToDict } from "./context.js";
import type { MessageDict, OpenAICompatibleToolSpec } from "./types.js";
import type { Forge } from "./forge.js";
import type { ToolRegistry } from "./tools.js";

export interface SessionData {
  version: string;
  model: string;
  system: string | null;
  messages: MessageDict[];
  tools: OpenAICompatibleToolSpec[];
  metadata: Record<string, unknown>;
}

export class Session {
  constructor(
    public model: string,
    public system: string | null,
    public messages: MessageDict[],
    public toolSpecs: OpenAICompatibleToolSpec[],
    public metadata: Record<string, unknown> = {},
    public version: string = "0.2.0",
  ) {}

  static fromForge(forge: Forge): Session {
    const sysMsg = forge.context.messages[0];
    const system =
      sysMsg?.role === "system" ? (sysMsg.content ?? null) : null;

    return new Session(
      forge.model,
      system,
      forge.context.toList(),
      forge.tools.toOpenAISpecs(),
      {
        created_at: new Date().toISOString(),
        message_count: forge.context.messages.length,
      },
    );
  }

  save(path: string): void {
    const data: SessionData = {
      version: this.version,
      model: this.model,
      system: this.system,
      messages: this.messages,
      tools: this.toolSpecs,
      metadata: this.metadata,
    };
    const dir = dirname(path);
    if (dir) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  }

  static load(path: string): Session {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);

    if (!data.messages) {
      throw new Error(`Invalid session file: ${path} (missing 'messages')`);
    }

    return new Session(
      data.model ?? "deepseek-chat",
      data.system ?? null,
      data.messages,
      data.tools ?? [],
      data.metadata ?? {},
      data.version ?? "unknown",
    );
  }

  validateTools(registry: ToolRegistry): boolean {
    const savedNames = new Set(
      this.toolSpecs
        .filter((s) => s.type === "function")
        .map((s) => s.function.name),
    );
    const missing: string[] = [];
    for (const name of savedNames) {
      if (!registry.has(name)) missing.push(name);
    }
    if (missing.length > 0) {
      console.warn(
        `Session has tools without registered callables: ${missing.join(", ")}. ` +
          `These tools will not be executable.`,
      );
      return false;
    }
    return true;
  }
}
