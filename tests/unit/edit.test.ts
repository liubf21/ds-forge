import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/tools.js";
import { editTool } from "../../src/edit.js";

describe("editTool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ds-forge-edit-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  async function edit(args: Record<string, unknown>, base = cwd) {
    const registry = new ToolRegistry();
    registry.register(editTool({ cwd: base }));
    return JSON.parse(await registry.execute("edit", args));
  }

  const FILE = "code.txt";
  function seed(content: string) {
    writeFileSync(join(cwd, FILE), content);
  }
  function read() {
    return readFileSync(join(cwd, FILE), "utf8");
  }

  it("replaces a multi-line range", async () => {
    seed("a\nb\nc\nd\ne\n");
    const res = await edit({
      path: FILE,
      startLine: 2,
      endLine: 4,
      newContent: "B\nC\nD",
    });

    expect(res.ok).toBe(true);
    expect(res.removedLines).toBe(3);
    expect(read()).toBe("a\nB\nC\nD\ne\n");
  });

  it("edits a single line when endLine is omitted", async () => {
    seed("one\ntwo\nthree\n");
    const res = await edit({ path: FILE, startLine: 2, newContent: "TWO" });

    expect(res.ok).toBe(true);
    expect(read()).toBe("one\nTWO\nthree\n");
  });

  it("passes when oldContent matches the range", async () => {
    seed("alpha\nbeta\ngamma\n");
    const res = await edit({
      path: FILE,
      startLine: 2,
      newContent: "BETA",
      oldContent: "beta",
    });

    expect(res.ok).toBe(true);
    expect(read()).toBe("alpha\nBETA\ngamma\n");
  });

  it("rejects when oldContent does not match and reports actual", async () => {
    seed("alpha\nbeta\ngamma\n");
    const res = await edit({
      path: FILE,
      startLine: 2,
      newContent: "BETA",
      oldContent: "WRONG",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/oldContent mismatch/i);
    expect(res.actual).toBe("beta");
    expect(res.expected).toBe("WRONG");
    // File untouched on rejection.
    expect(read()).toBe("alpha\nbeta\ngamma\n");
  });

  it("preserves a trailing newline", async () => {
    seed("x\ny\n");
    await edit({ path: FILE, startLine: 1, newContent: "Z" });

    expect(read()).toBe("Z\ny\n");
  });

  it("rejects startLine past EOF without touching the file", async () => {
    seed("only\n");
    const res = await edit({
      path: FILE,
      startLine: 50,
      newContent: "appended",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/past end of file/i);
    expect(res.totalLines).toBe(1);
    // File must be untouched on rejection.
    expect(read()).toBe("only\n");
  });

  it("returns ok:false for a missing file", async () => {
    const res = await edit({ path: "nope.txt", startLine: 1, newContent: "x" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it("refuses to edit a binary file", async () => {
    const bin = Buffer.from([0x00, 0x01, 0x02]);
    writeFileSync(join(cwd, "blob"), bin);
    const res = await edit({ path: "blob", startLine: 1, newContent: "x" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/binary/i);
  });

  it("deletes lines when newContent is empty", async () => {
    seed("a\nb\nc\nd\n");
    const res = await edit({
      path: FILE,
      startLine: 2,
      endLine: 3,
      newContent: "",
    });

    expect(res.ok).toBe(true);
    expect(read()).toBe("a\nd\n");
  });
});
