import { exec } from "node:child_process";
import { tool } from "./tools.js";

export interface BashOptions {
  /** Command timeout in ms (default 30_000). */
  timeout?: number;
  /** Max output characters returned (default 20_000). */
  maxOutput?: number;
  /** Working directory for commands. */
  cwd?: string;
}

export function bashTool(opts: BashOptions = {}) {
  const {
    timeout = 30_000,
    maxOutput = 20_000,
    cwd,
  } = opts;

  return tool({
    name: "bash",
    description: `Run a shell command. Full shell access (child_process.exec) — not sandboxed.

Working directory: ${cwd ?? "current directory"}
Timeout: ${timeout}ms
Max output: ${maxOutput} characters`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute (pipes, redirects, etc. allowed).",
        },
      },
      required: ["command"],
    },
    execute: async (args) => {
      const cmd = String(args.command);

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
