import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { MessageObj } from "../src/context.js";
import type { Forge } from "../src/forge.js";
import type { HistoryMessage, ToolBlock } from "./types.js";

export const TRAJECTORY_DIR = resolve(process.env.DS_FORGE_DIR ?? "./trajectories");

export function createTrajectoryPath(): string {
  mkdirSync(TRAJECTORY_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(TRAJECTORY_DIR, `task-${ts}.json`);
}

export function resolveTrajectoryPath(resume: string): string {
  return resolve(resume);
}

export function saveTrajectory(forge: Forge, path: string): void {
  forge.save(path);
}

export function historyFromContext(messages: MessageObj[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "user") {
      history.push({ role: "user", content: m.content ?? "" });
      continue;
    }
    if (m.role !== "assistant") continue;

    const tools: ToolBlock[] = [];
    for (const tc of m.tool_calls ?? []) {
      const resultMsg = messages
        .slice(i + 1)
        .find((x) => x.role === "tool" && x.tool_call_id === tc.id);
      tools.push({
        id: tc.id,
        name: tc.function.name,
        args: tc.function.arguments,
        result: resultMsg?.content ?? undefined,
        running: false,
      });
    }

    if (m.content || tools.length > 0) {
      history.push({ role: "assistant", content: m.content ?? "", tools });
    }
  }

  return history;
}

export function trajectoryLabel(path: string): string {
  return basename(path);
}
