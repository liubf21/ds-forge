import type { StreamEvent } from "../src/types.js";

export function truncateLine(s: string, max = 120): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}

export function formatToolCommand(name: string, args: string): string {
  if (name === "bash") {
    try {
      const parsed = JSON.parse(args) as { command?: string };
      return parsed.command ?? args;
    } catch {
      return args;
    }
  }
  return truncateLine(args, 80);
}

/** One-line status for tool completion — never dump full stdout. */
export function formatToolStatus(result: string | undefined, running: boolean): string {
  if (running) return "…";
  if (result === undefined) return "";
  const trimmed = result.trim();
  if (!trimmed) return "✓";
  const lines = result.split("\n").length;
  if (lines === 1 && trimmed.length <= 48) return `✓ ${trimmed}`;
  return `✓ ${lines} lines`;
}

export function applyEvent<T extends { content: string; tools: Array<{ id: string; name: string; args: string; result?: string; running: boolean }> }>(
  turn: T,
  ev: StreamEvent,
): T {
  switch (ev.type) {
    case "text_delta":
      return { ...turn, content: turn.content + ev.delta };
    case "tool_call_start":
      return {
        ...turn,
        tools: [
          ...turn.tools,
          { id: ev.id, name: ev.name, args: ev.arguments, running: true },
        ],
      };
    case "tool_result":
      return {
        ...turn,
        tools: turn.tools.map((t) =>
          t.id === ev.id ? { ...t, result: ev.result, running: false } : t,
        ),
      };
    default:
      return turn;
  }
}
