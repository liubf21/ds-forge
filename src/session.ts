import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_MODEL } from "./defaults.js";
import type { MessageDict, OpenAICompatibleToolSpec } from "./types.js";
import type { Forge } from "./forge.js";
import type { ToolRegistry } from "./tools.js";
import { VERSION } from "./version.js";

export type { UsageRecord } from "./usage.js";

export interface SessionData {
  version: string;
  model: string;
  messages: MessageDict[];
  tools: OpenAICompatibleToolSpec[];
  metadata: Record<string, unknown>;
}

export class Session {
  constructor(
    public model: string,
    public messages: MessageDict[],
    public toolSpecs: OpenAICompatibleToolSpec[],
    public metadata: Record<string, unknown> = {},
    public version: string = VERSION,
  ) {}

  get system(): string | null {
    const sysMsg = this.messages.find((m) => m.role === "system");
    return sysMsg?.content ?? null;
  }

  static fromForge(forge: Forge): Session {
    return new Session(
      forge.model,
      forge.context.toList(),
      forge.tools.toOpenAISpecs(),
      {
        created_at: forge.createdAt,
        message_count: forge.context.messages.length,
        usage_log: forge.usageLog,
      },
    );
  }

  save(path: string): void {
    const data: SessionData = {
      version: this.version,
      model: this.model,
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
      data.model ?? DEFAULT_MODEL,
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
