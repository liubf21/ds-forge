import { exec } from "node:child_process";
import { tool } from "./tools.js";

export interface BashOptions {
  /** Command timeout in ms (default 30_000). */
  timeout?: number;
  /** Max output characters returned (default 20_000). */
  maxOutput?: number;
  /** Working directory for commands. */
  cwd?: string;
  /** Whitelist of allowed commands. If set, only these executables can run. */
  allowlist?: string[];
}

/** Extract the base command name from a shell string. */
function baseCommand(cmd: string): string {
  const trimmed = cmd.trim().replace(/^\S+\s+.*/, (m) => m.split(/\s+/)[0] ?? m);
  // Handle pipelines — take the first segment
  const first = trimmed.split("|")[0]?.trim() ?? trimmed;
  return first.split(/\s+/)[0] ?? first;
}

export function bashTool(opts: BashOptions = {}) {
  const {
    timeout = 30_000,
    maxOutput = 20_000,
    cwd,
    allowlist,
  } = opts;

  return tool({
    name: "bash",
    description: `Execute a shell command. Returns stdout + stderr.

Working directory: ${cwd ?? "current directory"}
Timeout: ${timeout}ms
${allowlist ? `Allowed commands: ${allowlist.join(", ")}` : "Any command is allowed."}`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute. Use pipes, redirects, etc.",
        },
      },
      required: ["command"],
    },
    execute: async (args) => {
      const cmd = String(args.command);

      if (allowlist && allowlist.length > 0) {
        const name = baseCommand(cmd);
        if (!allowlist.includes(name)) {
          return `Error: command '${name}' not in allowlist. Allowed: ${allowlist.join(", ")}`;
        }
      }

      return new Promise<string>((resolve) => {
        const child = exec(cmd, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          const parts: string[] = [];
          if (stdout) parts.push(stdout.trimEnd());
          if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
          if (err && err.killed) parts.push("[timed out]");
          if (err && !err.killed && err.code !== 0) {
            parts.push(`[exit ${err.code}]`);
          }
          let out = parts.join("\n") || "(no output)";
          if (out.length > maxOutput) {
            out = out.slice(0, maxOutput) + `\n... (truncated, ${out.length - maxOutput} more chars)`;
          }
          resolve(out);
        });
      });
    },
  });
}
