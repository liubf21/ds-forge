/**
 * `read` tool — read a file with line numbers (cat -n style).
 *
 * Pure read, no side effects. The line-numbered output is what makes line-based
 * `edit` reliable downstream: the model cites exact line numbers it already saw,
 * so it never needs to reproduce file contents from memory.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isBinary } from "./binary.js";
import { tool } from "./tools.js";

export interface ReadOptions {
  /** Base directory for relative paths. Default: process.cwd(). */
  cwd?: string;
  /** Max output characters (default 200_000). Reads past this are truncated. */
  maxBytes?: number;
}

/** Default output cap — keeps a single read from dominating the context. */
const DEFAULT_MAX_BYTES = 200_000;

export function readTool(opts: ReadOptions = {}) {
  const { cwd = process.cwd(), maxBytes = DEFAULT_MAX_BYTES } = opts;

  return tool({
    name: "read",
    description: `Read a file and return it with line numbers (cat -n style). Relative paths resolve against: ${cwd}

Use this before editing — the line numbers it returns are how you target edits.
Binary files (images, build artifacts) are refused rather than returned as garbage.`,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path, relative to cwd or absolute.",
        },
        startLine: {
          type: "number",
          description: "First line to return (1-based, inclusive). Defaults to 1.",
        },
        endLine: {
          type: "number",
          description: "Last line to return (1-based, inclusive). Defaults to EOF.",
        },
      },
      required: ["path"],
    },
    execute: (args) => {
      const target = resolve(cwd, String(args.path));

      if (!existsSync(target)) {
        return { ok: false, error: `File not found: ${args.path}`, path: target };
      }
      if (!statSync(target).isFile()) {
        return { ok: false, error: `Not a file: ${args.path}`, path: target };
      }

      const buf = readFileSync(target);
      if (isBinary(buf)) {
        return {
          ok: false,
          error: "Binary file, not displayed.",
          path: target,
          bytes: buf.length,
        };
      }

      const text = buf.toString("utf8");
      const allLines = text.split("\n");
      // A trailing newline produces a phantom empty last element; drop it so line
      // numbers line up with what an editor shows.
      if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
        allLines.pop();
      }

      const start = Math.max(1, Math.floor(Number(args.startLine) || 1));
      const end = args.endLine != null
        ? Math.min(allLines.length, Math.floor(Number(args.endLine)))
        : allLines.length;

      if (start > allLines.length || end < start) {
        return {
          ok: true,
          path: target,
          totalLines: allLines.length,
          content: `(no lines in range ${start}-${end}; file has ${allLines.length} lines)`,
        };
      }

      // Align numbers to the file's total-line width so a file's gutter is
      // stable across slices and matches what an editor / cat -n shows.
      const width = String(allLines.length).length;
      const selected = [];
      for (let i = start; i <= end; i++) {
        const num = String(i).padStart(width, " ");
        selected.push(`${num}\t${allLines[i - 1]}`);
      }
      let content = selected.join("\n");

      const note = `(${start}-${end} of ${allLines.length} lines)`;
      if (content.length > maxBytes) {
        const over = content.length - maxBytes;
        content =
          content.slice(0, maxBytes) +
          `\n... (truncated, ${over} more chars)`;
      }

      return { ok: true, path: target, totalLines: allLines.length, note, content };
    },
  });
}
