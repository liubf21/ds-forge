import type { Tool, ToolDef, OpenAICompatibleToolSpec } from "./types.js";

export function toolToOpenAISpec(tool: ToolDef): OpenAICompatibleToolSpec {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

export function tool(def: Tool): Tool {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: def.execute,
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
    return Array.from(this.tools.values(), toolToOpenAISpec);
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
