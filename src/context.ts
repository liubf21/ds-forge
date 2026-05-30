import type { MessageDict, ToolCall } from "./types.js";

export type { MessageDict };

/** Estimate tokens — char/4 heuristic. */
export function defaultTokenCounter(messages: MessageDict[]): number {
  const text = JSON.stringify(messages);
  return Math.max(0, Math.floor(text.length / 4));
}

export function messageToDict(m: MessageObj): MessageDict {
  const d: MessageDict = { role: m.role };
  if (m.content != null) d.content = m.content;
  if (m.reasoning_content != null) d.reasoning_content = m.reasoning_content;
  if (m.tool_calls != null) d.tool_calls = m.tool_calls;
  if (m.tool_call_id != null) d.tool_call_id = m.tool_call_id;
  if (m.name != null) d.name = m.name;
  return d;
}

export function messageFromDict(d: MessageDict): MessageObj {
  return {
    role: d.role,
    content: d.content,
    reasoning_content: d.reasoning_content,
    tool_calls: d.tool_calls,
    tool_call_id: d.tool_call_id,
    name: d.name,
  };
}

export interface MessageObj {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export class Context {
  messages: MessageObj[] = [];
  tokenCounter: (msgs: MessageDict[]) => number = defaultTokenCounter;
  maxTokens: number = 128_000;

  add(message: MessageObj): void {
    this.messages.push(message);
  }

  addSystem(content: string): void {
    this.messages = this.messages.filter((m) => m.role !== "system");
    this.messages.unshift({ role: "system", content });
  }

  addUser(content: string): void {
    this.messages.push({ role: "user", content });
  }

  addAssistant(
    content?: string | null,
    tool_calls?: ToolCall[],
    reasoning_content?: string | null,
  ): void {
    this.messages.push({ role: "assistant", content, tool_calls, reasoning_content });
  }

  addToolResult(
    tool_call_id: string,
    content: string,
    name?: string,
  ): void {
    this.messages.push({ role: "tool", content, tool_call_id, name });
  }

  toList(): MessageDict[] {
    return this.messages.map(messageToDict);
  }

  tokenCount(): number {
    if (this.messages.length === 0) return 0;
    return this.tokenCounter(this.toList());
  }

  truncate(maxTokens?: number): void {
    const limit = maxTokens ?? this.maxTokens;

    while (this.tokenCount() > limit) {
      const idx = this.messages.findIndex((m) => m.role !== "system");
      if (idx === -1) {
        // Only system messages remain — truncate content
        if (this.messages[0]?.role === "system" && this.messages[0].content) {
          const overage = this.tokenCount() - limit;
          const trim = Math.min(
            this.messages[0].content.length,
            Math.max(overage * 4 + 100, 100),
          );
          this.messages[0].content = this.messages[0].content.slice(0, -trim) || "";
        }
        break;
      }
      this.messages.splice(idx, 1);
    }
  }

  last(): MessageObj | undefined {
    return this.messages.at(-1);
  }

  clear(): void {
    this.messages = [];
  }

  static fromDicts(dicts: MessageDict[]): Context {
    const ctx = new Context();
    ctx.messages = dicts.map(messageFromDict);
    return ctx;
  }
}
