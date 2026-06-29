/**
 * Built-in tool presets — register by name for CLIs and AgentSession.
 *
 *   builtinTools(["read", "edit"], { cwd })
 *   parseToolNames("bash,read")
 */

import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import type { BashOptions } from "./bash.js";
import type { Tool } from "./types.js";

export const BUILTIN_TOOL_NAMES = ["bash", "read", "write", "edit"] as const;
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export interface BuiltinToolsOptions {
  cwd?: string;
  bash?: BashOptions;
}

/** Parse a comma-separated tool list from CLI flags. */
export function parseToolNames(raw: string): BuiltinToolName[] {
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: BuiltinToolName[] = [];
  for (const name of names) {
    if (!isBuiltinToolName(name)) {
      throw new Error(
        `Unknown tool: ${name}. Available: ${BUILTIN_TOOL_NAMES.join(", ")}`,
      );
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return (BUILTIN_TOOL_NAMES as readonly string[]).includes(name);
}

/** Instantiate built-in tools by name. Unknown names throw. */
export function builtinTools(
  names: readonly BuiltinToolName[],
  opts: BuiltinToolsOptions = {},
): Tool[] {
  const cwd = opts.cwd ?? process.cwd();
  return names.map((name) => {
    switch (name) {
      case "bash":
        return bashTool({ cwd, ...opts.bash });
      case "read":
        return readTool({ cwd });
      case "write":
        return writeTool({ cwd });
      case "edit":
        return editTool({ cwd });
      default: {
        const _exhaustive: never = name;
        throw new Error(`Unhandled tool: ${_exhaustive}`);
      }
    }
  });
}
