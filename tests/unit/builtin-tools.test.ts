import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  builtinTools,
  parseToolNames,
} from "../../src/builtin-tools.js";

describe("parseToolNames", () => {
  it("parses comma-separated names and dedupes", () => {
    expect(parseToolNames("bash, read, bash")).toEqual(["bash", "read"]);
  });

  it("throws on unknown tools", () => {
    expect(() => parseToolNames("bash,foo")).toThrow(/Unknown tool: foo/);
  });
});

describe("builtinTools", () => {
  it("instantiates requested tools", () => {
    const tools = builtinTools(["read", "edit"], { cwd: "/tmp" });
    expect(tools.map((t) => t.name)).toEqual(["read", "edit"]);
  });

  it("covers every builtin name", () => {
    const tools = builtinTools([...BUILTIN_TOOL_NAMES], { cwd: "/tmp" });
    expect(tools.map((t) => t.name).sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
  });
});
