/**
 * `write` tool — create or overwrite a file with full content.
 *
 * Deliberately separate from `edit`: `write` is the "create new file" path and
 * refuses to clobber by default, so the model has to be explicit (`overwrite`)
 * when it means to replace. This makes accidental overwrites a conscious act.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tool } from "./tools.js";

export interface WriteOptions {
  /** Base directory for relative paths. Default: process.cwd(). */
  cwd?: string;
}

export function writeTool(opts: WriteOptions = {}) {
  const { cwd = process.cwd() } = opts;

  return tool({
    name: "write",
    description: `Create a file with the given content. Relative paths resolve against: ${cwd}

By default refuses to overwrite an existing file — pass overwrite:true to replace.
For targeted edits to an existing file, use \`edit\` instead; use \`write\` for new
files or full rewrites.`,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path, relative to cwd or absolute.",
        },
        content: {
          type: "string",
          description: "Full file content to write.",
        },
        overwrite: {
          type: "boolean",
          description: "If true, overwrite an existing file. Default false.",
        },
        mkdir: {
          type: "boolean",
          description: "If true, create parent directories as needed. Default false.",
        },
      },
      required: ["path", "content"],
    },
    execute: (args) => {
      const target = resolve(cwd, String(args.path));
      const content = String(args.content);

      if (existsSync(target) && args.overwrite !== true) {
        return {
          ok: false,
          error: "File exists; set overwrite:true to replace.",
          path: target,
        };
      }

      if (args.mkdir === true) {
        mkdirSync(dirname(target), { recursive: true });
      }

      writeFileSync(target, content);
      // Count lines the same way read/edit do: a trailing newline is a
      // terminator, not an extra empty line, so "a\nb\n" is 2 lines.
      const parts = content.split("\n");
      if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
      const lines = parts.length;

      return { ok: true, path: target, bytes: Buffer.byteLength(content), lines };
    },
  });
}
