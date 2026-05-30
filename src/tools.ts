import type { Tool, ToolDef, OpenAICompatibleToolSpec } from "./types.js";

export function tool(def: ToolDef & { execute: Tool["execute"] }): Tool {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: def.execute,
    toOpenAISpec(): OpenAICompatibleToolSpec {
      return {
        type: "function",
        function: {
          name: def.name,
          description: def.description,
          parameters: def.parameters,
        },
      };
    },
  };
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(t: Tool): void {
    this.tools.set(t.name, t);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  toOpenAISpecs(): OpenAICompatibleToolSpec[] {
    return Array.from(this.tools.values(), (t) => t.toOpenAISpec());
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const t = this.tools.get(name);
    if (!t) {
      return `Error: Unknown tool '${name}'`;
    }
    try {
      const result = await t.execute(args);
      if (typeof result === "string") return result;
      return JSON.stringify(result);
    } catch (e) {
      return `Error executing ${name}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get size(): number {
    return this.tools.size;
  }

  [Symbol.iterator](): IterableIterator<Tool> {
    return this.tools.values();
  }
}
