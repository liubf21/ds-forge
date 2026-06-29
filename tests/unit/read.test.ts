import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/tools.js";
import { readTool } from "../../src/read.js";

describe("readTool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ds-forge-read-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  async function read(args: Record<string, unknown>, base = cwd) {
    const registry = new ToolRegistry();
    registry.register(readTool({ cwd: base }));
    return JSON.parse(await registry.execute("read", args));
  }

  it("returns line-numbered content", async () => {
    writeFileSync(join(cwd, "f.txt"), "alpha\nbeta\n");
    const res = await read({ path: "f.txt" });

    expect(res.ok).toBe(true);
    expect(res.totalLines).toBe(2);
    expect(res.content).toContain("1\talpha");
    expect(res.content).toContain("2\tbeta");
  });

  it("slices with startLine and endLine, padding to total-line width", async () => {
    // 12 lines → gutter width 2, so single-digit numbers get one leading space.
    const body = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n");
    writeFileSync(join(cwd, "f.txt"), body + "\n");
    const res = await read({ path: "f.txt", startLine: 2, endLine: 4 });

    expect(res.note).toBe("(2-4 of 12 lines)");
    expect(res.content).toBe(" 2\tl2\n 3\tl3\n 4\tl4");
  });

  it("clamps endLine past EOF to the last line", async () => {
    writeFileSync(join(cwd, "f.txt"), "a\nb\n");
    const res = await read({ path: "f.txt", startLine: 1, endLine: 99 });

    expect(res.totalLines).toBe(2);
    expect(res.content).toBe("1\ta\n2\tb");
  });

  it("returns ok:false for a missing file", async () => {
    const res = await read({ path: "nope.txt" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it("refuses binary files with size metadata", async () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
    writeFileSync(join(cwd, "img.png"), bin);
    const res = await read({ path: "img.png" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/binary/i);
    expect(res.bytes).toBe(bin.length);
  });

  it("truncates output over maxBytes", async () => {
    const big = "x".repeat(500);
    writeFileSync(join(cwd, "big.txt"), big + "\n");
    const registry = new ToolRegistry();
    registry.register(readTool({ cwd, maxBytes: 50 }));
    const res = JSON.parse(await registry.execute("read", { path: "big.txt" }));

    expect(res.content.length).toBeLessThanOrEqual(big.length);
    expect(res.content).toMatch(/truncated/);
  });

  it("resolves relative paths against cwd", async () => {
    writeFileSync(join(cwd, "rel.txt"), "hello\n");
    const res = await read({ path: "rel.txt" });

    expect(res.ok).toBe(true);
    expect(res.path).toBe(join(cwd, "rel.txt"));
  });
});
