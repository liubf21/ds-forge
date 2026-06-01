import { DEFAULT_MAX_TOKENS } from "./defaults.js";
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
  if (d.role === "assistant") {
    return { role: "assistant", ...normalizeAssistantFields(d.content, d.tool_calls, d.reasoning_content) };
  }
  return {
    role: d.role,
    content: d.content,
    reasoning_content: d.reasoning_content,
    tool_calls: d.tool_calls,
    tool_call_id: d.tool_call_id,
    name: d.name,
  };
}

/**
 * Normalize assistant fields for storage / API.
 * - Non-tool replies: promote reasoning-only text to content (streaming quirk).
 * - Non-tool replies: drop reasoning_content (API ignores prior-turn CoT anyway).
 * - Tool turns: keep reasoning_content for round-trip.
 */
export function normalizeAssistantFields(
  content: string | null | undefined,
  tool_calls: ToolCall[] | undefined,
  reasoning_content: string | null | undefined,
): Pick<MessageObj, "content" | "tool_calls" | "reasoning_content"> {
  const hasTools = (tool_calls?.length ?? 0) > 0;
  let c = content ?? null;
  let rc = reasoning_content ?? null;

  if (!hasTools) {
    if (!c && rc) {
      c = rc;
      rc = null;
    } else if (c && rc) {
      rc = null;
    }
  }

  const out: Pick<MessageObj, "content" | "tool_calls" | "reasoning_content"> = {};
  if (c != null) out.content = c;
  if (hasTools) out.tool_calls = tool_calls;
  if (rc != null) out.reasoning_content = rc;
  return out;
}

/** Shape messages for DeepSeek API (repairs legacy reasoning-only assistant rows). */
export function messagesForApi(messages: MessageDict[]): MessageDict[] {
  return messages.map((m) => {
    if (m.role !== "assistant") return m;

    const hasTools = (m.tool_calls?.length ?? 0) > 0;
    if (hasTools) {
      const out: MessageDict = { role: "assistant", tool_calls: m.tool_calls };
      if (m.content != null) out.content = m.content;
      if (m.reasoning_content != null) out.reasoning_content = m.reasoning_content;
      return out;
    }

    return {
      role: "assistant",
      content: m.content ?? m.reasoning_content ?? "",
    };
  });
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
  maxTokens: number = DEFAULT_MAX_TOKENS;

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
    this.messages.push({
      role: "assistant",
      ...normalizeAssistantFields(content, tool_calls, reasoning_content),
    });
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
        throw new Error(
          `Context exceeds maxTokens (${limit}): only system message(s) remain (~${this.tokenCount()} tokens). ` +
            "Shorten the system prompt or raise maxTokens.",
        );
      }
      this.messages.splice(idx, 1);
    }
  }

  get length(): number {
    return this.messages.length;
  }

  /** Shallow-copy the message array — safe against truncate(). */
  snapshot(): MessageObj[] {
    return this.messages.slice();
  }

  /** Restore from a previous snapshot. */
  restore(snapshot: MessageObj[]): void {
    this.messages = snapshot;
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
