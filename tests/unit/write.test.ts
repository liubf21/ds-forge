import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ToolRegistry } from "../../src/tools.js";
import { writeTool } from "../../src/write.js";

describe("writeTool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ds-forge-write-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  async function write(args: Record<string, unknown>, base = cwd) {
    const registry = new ToolRegistry();
    registry.register(writeTool({ cwd: base }));
    return JSON.parse(await registry.execute("write", args));
  }

  it("creates a new file with the given content", async () => {
    const res = await write({ path: "new.txt", content: "hello\nworld\n" });

    expect(res.ok).toBe(true);
    expect(res.bytes).toBe(12);
    expect(res.lines).toBe(2);
    expect(readFileSync(join(cwd, "new.txt"), "utf8")).toBe("hello\nworld\n");
  });

  it("refuses to overwrite without overwrite:true", async () => {
    writeFileSync(join(cwd, "exists.txt"), "old\n");
    const res = await write({ path: "exists.txt", content: "new\n" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exists/i);
    expect(readFileSync(join(cwd, "exists.txt"), "utf8")).toBe("old\n");
  });

  it("overwrites when overwrite:true", async () => {
    writeFileSync(join(cwd, "exists.txt"), "old\n");
    const res = await write({ path: "exists.txt", content: "new\n", overwrite: true });

    expect(res.ok).toBe(true);
    expect(readFileSync(join(cwd, "exists.txt"), "utf8")).toBe("new\n");
  });

  it("creates parent directories with mkdir:true", async () => {
    const res = await write({
      path: "nested/deep/file.txt",
      content: "x",
      mkdir: true,
    });

    expect(res.ok).toBe(true);
    expect(existsSync(join(cwd, "nested/deep/file.txt"))).toBe(true);
  });

  it("fails to write into a missing directory without mkdir", async () => {
    const registry = new ToolRegistry();
    registry.register(writeTool({ cwd }));
    // Filesystem error surfaces as a JSON error string via ToolRegistry's catch.
    const res = await registry.execute("write", { path: "missing/dir/f.txt", content: "x" });

    expect(res).toMatch(/error/i);
  });

  it("counts zero lines for empty content", async () => {
    const res = await write({ path: "empty.txt", content: "" });

    expect(res.ok).toBe(true);
    expect(res.lines).toBe(0);
    expect(statSync(join(cwd, "empty.txt")).size).toBe(0);
  });

  it("resolves relative paths against cwd", async () => {
    const res = await write({ path: "rel.txt", content: "hi" });

    expect(res.path).toBe(join(cwd, "rel.txt"));
    // dirname import keeps the test honest about path semantics.
    expect(dirname(res.path)).toBe(cwd);
  });
});
