/**
 * `edit` tool — replace a line range in an existing file.
 *
 * Line-based editing (not search/replace): the model cites line numbers it got
 * from `read`, so it never has to reproduce file text verbatim. The optional
 * `oldContent` is a guard, not a locator — when provided it must match the
 * current range exactly, catching drift between the read and the edit.
 *
 * Only the line strategy is supported. Search/replace was deliberately left out:
 * it depends on the model reproducing existing strings character-for-character,
 * which is the highest-error-rate operation for an LLM.
 */

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isBinary } from "./binary.js";
import { tool } from "./tools.js";

export interface EditOptions {
  /** Base directory for relative paths. Default: process.cwd(). */
  cwd?: string;
}

/** Split file content into lines, dropping the trailing-empty element produced by a final newline. */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function editTool(opts: EditOptions = {}) {
  const { cwd = process.cwd() } = opts;

  return tool({
    name: "edit",
    description: `Replace a range of lines in an existing file. Relative paths resolve against: ${cwd}

Call \`read\` first to get exact line numbers, then edit by range:
  startLine (1-based, inclusive) .. endLine (defaults to startLine).
Pass \`oldContent\` with the current text of that range to guard against stale
line numbers — if it doesn't match exactly, the edit is rejected so you can
re-read. This tool only edits existing files; use \`write\` for new files.`,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path, relative to cwd or absolute. Must already exist.",
        },
        startLine: {
          type: "number",
          description: "First line to replace (1-based, inclusive).",
        },
        endLine: {
          type: "number",
          description: "Last line to replace (1-based, inclusive). Defaults to startLine.",
        },
        newContent: {
          type: "string",
          description: "Replacement text for the line range. May span multiple lines.",
        },
        oldContent: {
          type: "string",
          description: "Optional exact current content of the range; if provided and it doesn't match, the edit is rejected.",
        },
      },
      required: ["path", "startLine", "newContent"],
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
          error: "Binary file, not edited.",
          path: target,
          bytes: buf.length,
        };
      }

      const text = buf.toString("utf8");
      const hadTrailingNewline = text.endsWith("\n");
      const lines = splitLines(text);

      const startRaw = Math.floor(Number(args.startLine));
      if (!Number.isFinite(startRaw) || startRaw < 1) {
        return { ok: false, error: `startLine must be a positive integer (got ${args.startLine})`, path: target };
      }
      // A startLine past EOF means the model is working from stale line numbers.
      // Clamping-and-replacing would silently destroy the last line, so reject
      // and tell the caller to re-read instead.
      if (startRaw > lines.length) {
        return {
          ok: false,
          error: `startLine ${startRaw} is past end of file (file has ${lines.length} lines).`,
          path: target,
          totalLines: lines.length,
          hint: "Re-read the file to get current line numbers. To append, use the last line as startLine.",
        };
      }
      const endRaw = args.endLine != null
        ? Math.floor(Number(args.endLine))
        : startRaw;

      const start = startRaw;
      // endLine may run past EOF (replace through end of file); clamp it.
      const end = Math.min(Math.max(endRaw, start), lines.length);

      // Optional guard: verify the range hasn't drifted since the last read.
      if (args.oldContent !== undefined) {
        const current = lines.slice(start - 1, end).join("\n");
        if (current !== args.oldContent) {
          return {
            ok: false,
            error: "oldContent mismatch — the file changed or the line numbers are stale.",
            path: target,
            expected: args.oldContent,
            actual: current,
            hint: "Re-read the file to get the current content and line numbers.",
          };
        }
      }

      const replacementLines =
        String(args.newContent) === ""
          ? []
          : String(args.newContent).split("\n");

      const before = lines.slice(0, start - 1);
      const after = lines.slice(end);
      const next = [...before, ...replacementLines, ...after];

      const out =
        next.join("\n") +
        (next.length > 0 && hadTrailingNewline ? "\n" : "");

      writeFileSync(target, out);

      return {
        ok: true,
        path: target,
        changedLines: { from: start, to: start + replacementLines.length - 1 },
        removedLines: end - start + 1,
        totalLines: next.length,
      };
    },
  });
}
