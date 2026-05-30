/**
 * Stdio transport — spawns an MCP server process and communicates
 * via newline-delimited JSON-RPC over stdin/stdout.
 *
 * Each message is exactly one line of JSON, terminated by \n.
 * This is the simplest transport and the most common for local tools.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { MCPTransport, TransportCallbacks, JSONRPCMessage } from "./types.js";

export interface StdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class StdioTransport implements MCPTransport {
  private proc: ChildProcess | null = null;
  private cbs: TransportCallbacks | null = null;
  private buffer = "";

  constructor(private config: StdioConfig) {}

  setCallbacks(cb: TransportCallbacks): void {
    this.cbs = cb;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { command, args = [], env, cwd } = this.config;
      const proc = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...env },
        cwd,
      });

      // spawn() doesn't throw synchronously for bad binaries —
      // the 'error' event fires async. Track settlement so we
      // don't resolve before the error has a chance to fire.
      let settled = false;

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        const msg = err.message.includes("ENOENT")
          ? `MCP server binary not found: ${command}`
          : err.message;
        reject(new Error(msg));
      });

      proc.on("exit", (code) => {
        this.cbs?.onClose();
        if (code !== 0 && code !== null) {
          this.cbs?.onError(new Error(`MCP server exited with code ${code}`));
        }
      });

      // Stderr: route through onError as non-fatal feedback
      if (proc.stderr) {
        let errBuf = "";
        proc.stderr.on("data", (chunk: Buffer) => {
          errBuf += chunk.toString();
          const lines = errBuf.split("\n");
          errBuf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) this.cbs?.onError(new Error(`[server stderr] ${line}`));
          }
        });
      }

      // Stdout: buffer and parse newline-delimited JSON
      proc.stdout!.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as JSONRPCMessage;
            this.cbs?.onMessage(msg);
          } catch {
            this.cbs?.onError(new Error(`Unparseable JSON from server: ${line.slice(0, 200)}`));
          }
        }
      });

      // Defer resolve by one tick — if the binary doesn't exist,
      // the 'error' event fires before this runs.
      setImmediate(() => {
        if (!settled) {
          settled = true;
          this.proc = proc;
          resolve();
        }
      });
    });
  }

  async send(msg: JSONRPCMessage): Promise<void> {
    if (!this.proc?.stdin) {
      throw new Error("Stdio transport not started");
    }
    const line = JSON.stringify(msg) + "\n";
    return new Promise((resolve, reject) => {
      this.proc!.stdin!.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;

    return new Promise((resolve) => {
      const force = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2_000);

      proc.on("exit", () => {
        clearTimeout(force);
        resolve();
      });

      proc.stdin?.end();
      proc.kill("SIGTERM");
    });
  }
}
